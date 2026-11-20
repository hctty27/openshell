package sshclient

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"fmt"
	"regexp"
	"sync"
	"testing"
	"time"
)

type nativeTerminalCapturedInput struct {
	mu sync.Mutex
	ch chan []byte
	all [][]byte
}

func (w *nativeTerminalCapturedInput) Write(p []byte) (int, error) {
	copyOfP := append([]byte(nil), p...)
	w.mu.Lock()
	w.all = append(w.all, copyOfP)
	w.mu.Unlock()
	select {
	case w.ch <- copyOfP:
	default:
	}
	return len(p), nil
}


func nativeTerminalCompletionFromCommand(t *testing.T, command string, status int) []byte {
	t.Helper()
	pattern := regexp.MustCompile("OpenShellNativeZmodem;([0-9a-f]{32});")
	matched := pattern.FindStringSubmatch(command)
	if len(matched) != 2 {
		t.Fatalf("remote command did not include a nonce-bound completion marker: %q", command)
	}
	return []byte(fmt.Sprintf("\x1b]777;OpenShellNativeZmodem;%s;%d\x07", matched[1], status))
}

func nativeTerminalNextInput(t *testing.T, capture *nativeTerminalCapturedInput) []byte {
	t.Helper()
	select {
	case p := <-capture.ch:
		return p
	case <-time.After(4*time.Second):
		t.Fatal("timed out waiting for remote terminal input")
		return nil
	}
}

func TestNativeZmodemInteractiveCoordinatorUploadHandoffAndRecovery(t *testing.T) {
	var legacy bytes.Buffer
	capture := &nativeTerminalCapturedInput{ch: make(chan []byte, 8)}
	input := newTerminalInputGate(io.Discard, capture)
	output := newTerminalOutputGate(&legacy)
	file := filepath.Join(t.TempDir(), "中文文件.bin")
	if err := os.WriteFile(file, []byte("source"), 0600); err != nil { t.Fatal(err) }

	received := make(chan []byte, 1)
	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: func(ctx context.Context, direction, localPath string, in io.ReadCloser, out io.Writer) error {
			if direction != "send" || localPath != file {
				return errors.New("invalid sidecar direction or file")
			}
			// A sidecar may emit a handshake immediately upon startup.
			// It MUST NOT reach the shell before the remote start frame.
			if _, err := out.Write([]byte("native-control")); err != nil { return err }
			data := make([]byte, nativeZmodemHeaderSize+len("binary-payload"))
			if _, err := io.ReadFull(in, data); err != nil { return err }
			received <- data
			return nil
		},
	}
	done := make(chan error, 1)
	go func() { done <- coordinator.run(context.Background(), "upload", file, "") }()

	remoteCommand := string(nativeTerminalNextInput(t, capture))
	if !strings.Contains(remoteCommand, "{ rz -q;") {
		t.Fatalf("unexpected explicit command %q", remoteCommand)
	}
	select {
	case p := <-capture.ch:
		t.Fatalf("native handshake reached shell before header: %x", p)
	case <-time.After(30*time.Millisecond):
	}
	if n, err := input.Write([]byte("manual keys")); !errors.Is(err, errNativeTerminalInputBusy) || n != 0 {
		t.Fatalf("manual input was not blocked: %d %v", n, err)
	}
	header := nativeZmodemHeaderTestStream() // ZRINIT, upload
	if _, err := output.Write(append([]byte("shell>"), header[:7]...)); err != nil { t.Fatal(err) }
	if _, err := output.Write(append(append([]byte(nil), header[7:]...), []byte("binary-payload")...)); err != nil { t.Fatal(err) }
	if got := string(nativeTerminalNextInput(t, capture)); got != "native-control" {
		t.Fatalf("sidecar response was not released after header: %q", got)
	}
	select {
	case data := <-received:
		want := append(append([]byte(nil), header...), []byte("binary-payload")...)
		if !bytes.Equal(data, want) { t.Fatalf("lost ZMODEM bytes: %x", data) }
	case <-time.After(3*time.Second):
		t.Fatal("sidecar never received full frame")
	}
	if legacy.Len() != 0 { t.Fatalf("experimental shell echo leaked into legacy: %q", legacy.String()) }
	select {
	case err := <-done:
		t.Fatalf("restored terminal without verified remote boundary: %v", err)
	case <-time.After(30*time.Millisecond):
	}
	if _, err := output.Write(append(nativeTerminalCompletionFromCommand(t, remoteCommand, 0), []byte("shell-ready")...)); err != nil { t.Fatal(err) }
	select {
	case err := <-done:
		if err != nil { t.Fatal(err) }
	case <-time.After(3*time.Second):
		t.Fatal("remote completion did not restore terminal")
	}
	if _, err := input.Write([]byte("normal")); err != nil { t.Fatal(err) }
	if _, err := output.Write([]byte("prompt")); err != nil { t.Fatal(err) }
	if got := legacy.String(); got != "shell-readyprompt" {
		t.Fatalf("legacy output not restored: %q", got)
	}
}

func TestNativeZmodemInteractiveCoordinatorDownloadPublishesAfterRemoteProof(t *testing.T) {
	var legacy bytes.Buffer
	capture := &nativeTerminalCapturedInput{ch: make(chan []byte, 8)}
	input := newTerminalInputGate(io.Discard, capture)
	output := newTerminalOutputGate(&legacy)
	dest := t.TempDir()
	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: func(ctx context.Context, direction, stage string, in io.ReadCloser, out io.Writer) error {
			if direction != "receive" { return errors.New("wrong sidecar action") }
			if _, err := io.ReadFull(in, make([]byte, nativeZmodemHeaderSize)); err != nil { return err }
			return os.WriteFile(filepath.Join(stage, "result.txt"), []byte("download"), 0600)
		},
	}
	done := make(chan error, 1)
	go func() { done <- coordinator.run(context.Background(), "download", dest, "a'b.txt") }()
	remoteCommand := string(nativeTerminalNextInput(t, capture))
	if !strings.Contains(remoteCommand, "sz -q -- 'a'\\''b.txt';") {
		t.Fatalf("unsafe or wrong remote shell command %q", remoteCommand)
	}
	// Remote ZRQINIT denotes a download, not ZRINIT.
	header := nativeZmodemHeaderFixture(0)
	if len(header) != nativeZmodemHeaderSize { t.Fatal("invalid ZRQINIT fixture") }
	if _, err := output.Write(header[:3]); err != nil { t.Fatal(err) }
	if _, err := output.Write(header[3:]); err != nil { t.Fatal(err) }
	if _, err := os.Stat(filepath.Join(dest, "result.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("received file published before remote completion proof: %v", err)
	}
	if _, err := output.Write(append(nativeTerminalCompletionFromCommand(t, remoteCommand, 0), []byte("shell-ready")...)); err != nil { t.Fatal(err) }
	select {
	case err := <-done:
		if err != nil { t.Fatal(err) }
	case <-time.After(3*time.Second): t.Fatal("download coordinator stuck")
	}
	got, err := os.ReadFile(filepath.Join(dest, "result.txt"))
	if err != nil || string(got) != "download" { t.Fatalf("publish failed: %q %v", got, err) }
	staging, _ := filepath.Glob(filepath.Join(dest, ".openshell-zmodem-terminal-*"))
	if len(staging) != 0 { t.Fatalf("temporary download directories leaked: %v", staging) }
}

func TestNativeZmodemInteractiveCoordinatorWrongDirectionFailsClosed(t *testing.T) {
	var legacy bytes.Buffer
	capture := &nativeTerminalCapturedInput{ch: make(chan []byte, 4)}
	input := newTerminalInputGate(io.Discard, capture)
	output := newTerminalOutputGate(&legacy)
	file := filepath.Join(t.TempDir(), "send.bin")
	if err := os.WriteFile(file, []byte("sample"), 0600); err != nil { t.Fatal(err) }
	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: func(ctx context.Context, _ string, _ string, in io.ReadCloser, out io.Writer) error {
			<-ctx.Done()
			return ctx.Err()
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- coordinator.run(ctx, "upload", file, "") }()
	_ = nativeTerminalNextInput(t, capture)
	// ZRQINIT (download) must not be mistaken for upload's ZRINIT.
	_, _ = output.Write(nativeZmodemHeaderFixture(0))
	select {
	case err := <-done:
		if err == nil { t.Fatal("wrong-direction header accepted") }
	case <-time.After(3*time.Second): t.Fatal("wrong direction failed to abort")
	}
	if _, err := input.Write([]byte("unsafe fallback")); !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("failed session resumed legacy input without proof: %v", err)
	}
	if legacy.Len() != 0 { t.Fatalf("remote protocol leaked to UI: %x", legacy.Bytes()) }
}

func TestNativeZmodemInteractiveCoordinatorCancelBeforeHeaderKeepsTerminalIsolated(t *testing.T) {
	var legacy bytes.Buffer
	capture := &nativeTerminalCapturedInput{ch: make(chan []byte, 4)}
	input := newTerminalInputGate(io.Discard, capture)
	output := newTerminalOutputGate(&legacy)
	file := filepath.Join(t.TempDir(), "source.bin")
	if err := os.WriteFile(file, []byte("source"), 0600); err != nil { t.Fatal(err) }
	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: func(ctx context.Context, _ string, _ string, in io.ReadCloser, out io.Writer) error {
			_, err := out.Write([]byte("first handshake"))
			return err
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- coordinator.run(ctx, "upload", file, "") }()
	_ = nativeTerminalNextInput(t, capture)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) { t.Fatalf("cancel was not propagated: %v", err) }
	case <-time.After(3*time.Second):
		t.Fatal("cancel blocked before receiving protocol header")
	}
	if _, err := input.Write([]byte("unsafe fallback")); !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("cancelled terminal accepted user input: %v", err)
	}
}

func TestNativeZmodemInteractiveCoordinatorValidationRejectsUnsafeCommands(t *testing.T) {
	const token = "00112233445566778899aabbccddeeff"
	for _, item := range []struct{ direction, remote string }{
		{"download", ""}, {"download", "/tmp/new\n"},
		{"download", "/tmp/a\n/tmp/b"}, {"invalid", "x"},
	} {
		if _, _, err := nativeInteractiveFencedCommand(item.direction, item.remote, token); err == nil {
			t.Fatalf("accepted invalid remote command: %+v", item)
		}
	}
	for _, item := range []struct{ direction, remote, fragment, action string }{
		{"upload", "", "{ rz -q;", "send"},
		{"upload-overwrite", "", "{ rz -q -y;", "send"},
		{"download", "x y", "sz -q -- 'x y'", "receive"},
		{"download", "/tmp/a'file", "sz -q -- '/tmp/a'\\''file'", "receive"},
	} {
		cmd, action, err := nativeInteractiveFencedCommand(item.direction, item.remote, token)
		if err != nil || !strings.Contains(cmd, item.fragment) || action != item.action {
			t.Fatalf("invalid fenced command: %q %q %v", cmd, action, err)
		}
	}
	var legacy bytes.Buffer
	input := newTerminalInputGate(io.Discard, io.Discard)
	output := newTerminalOutputGate(&legacy)
	c := &nativeTerminalCoordinator{input: input, output: output,
		runner: func(context.Context, string, string, io.ReadCloser, io.Writer) error { return nil }}
	if err := c.run(context.Background(), "upload", "/does-not-exist", ""); err == nil {
		t.Fatal("accepted missing local file")
	}
	if err := c.run(nil, "upload", "/does-not-exist", ""); err == nil {
		t.Fatal("accepted nil transfer context")
	}
	if legacy.Len() != 0 { t.Fatal("validation wrote to SSH terminal") }
	if _, err := input.takeover(); err != nil { t.Fatalf("validation acquired a lease: %v", err) }
}

func TestNativeZmodemInteractiveCoordinatorConcurrentRequestCannotStealLeases(t *testing.T) {
	capture := &nativeTerminalCapturedInput{ch: make(chan []byte, 4)}
	input := newTerminalInputGate(io.Discard, capture)
	output := newTerminalOutputGate(io.Discard)
	file := filepath.Join(t.TempDir(), "source.bin")
	if err := os.WriteFile(file, []byte("data"), 0600); err != nil { t.Fatal(err) }
	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: func(ctx context.Context, _ string, _ string, in io.ReadCloser, out io.Writer) error {
			<-ctx.Done()
			return ctx.Err()
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- coordinator.run(ctx, "upload", file, "") }()
	_ = nativeTerminalNextInput(t, capture)
	if err := coordinator.run(context.Background(), "upload", file, ""); !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("overlapping native coordinator accepted: %v", err)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3*time.Second): t.Fatal("primary transfer did not cancel")
	}
}


func TestNativeZmodemInteractiveCoordinatorRequiresRemoteDrainProof(t *testing.T) {
	var legacy bytes.Buffer
	capture := &nativeTerminalCapturedInput{ch: make(chan []byte, 4)}
	input := newTerminalInputGate(io.Discard, capture)
	output := newTerminalOutputGate(&legacy)
	source := filepath.Join(t.TempDir(), "send.bin")
	if err := os.WriteFile(source, []byte("payload"), 0600); err != nil { t.Fatal(err) }
	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: func(ctx context.Context, direction, path string, in io.ReadCloser, out io.Writer) error {
			if direction != "send" { return errors.New("incorrect transfer direction") }
			_, err := io.ReadFull(in, make([]byte, nativeZmodemHeaderSize))
			return err
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- coordinator.run(ctx, "upload", source, "") }()
	_ = nativeTerminalNextInput(t, capture)
	if _, err := output.Write(nativeZmodemHeaderTestStream()); err != nil { t.Fatal(err) }
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("local sidecar success bypassed remote boundary proof: %v", err)
		}
	case <-time.After(3*time.Second): t.Fatal("missing remote proof did not time out")
	}
	if _, err := input.Write([]byte("unsafe user input")); !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("unconfirmed remote termination reopened stdin: %v", err)
	}
	if _, err := output.Write([]byte("binary tail")); err != nil { t.Fatal(err) }
	if legacy.Len() != 0 {
		t.Fatalf("unconfirmed binary tail leaked to terminal: %x", legacy.Bytes())
	}
}


func TestNativeZmodemInteractiveCoordinatorRemoteNonzeroExitRestoresVerifiedTerminal(t *testing.T) {
	var legacy bytes.Buffer
	capture := &nativeTerminalCapturedInput{ch: make(chan []byte, 4)}
	input := newTerminalInputGate(io.Discard, capture)
	output := newTerminalOutputGate(&legacy)
	file := filepath.Join(t.TempDir(), "send.bin")
	if err := os.WriteFile(file, []byte("payload"), 0600); err != nil { t.Fatal(err) }
	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: func(ctx context.Context, direction, path string, inbound io.ReadCloser, outbound io.Writer) error {
			_, err := io.ReadFull(inbound, make([]byte, nativeZmodemHeaderSize))
			return err
		},
	}
	done := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	go func() { done <- coordinator.run(ctx, "upload", file, "") }()
	command := string(nativeTerminalNextInput(t, capture))
	if _, err := output.Write(nativeZmodemHeaderTestStream()); err != nil { t.Fatal(err) }
	if _, err := output.Write(append(nativeTerminalCompletionFromCommand(t, command, 9), []byte("shell prompt")...)); err != nil { t.Fatal(err) }
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "退出状态为 9") {
			t.Fatalf("nonzero remote shell exit not reported: %v", err)
		}
	case <-time.After(3*time.Second): t.Fatal("remote failure never completed")
	}
	if _, err := input.Write([]byte("manual")); err != nil {
		t.Fatalf("verified remote exit did not restore input: %v", err)
	}
	if _, err := output.Write([]byte(" next prompt")); err != nil { t.Fatal(err) }
	if legacy.String() != "shell prompt next prompt" {
		t.Fatalf("verified shell output not correctly replayed: %q", legacy.String())
	}
}

func TestNativeZmodemInteractiveCoordinatorFailedDownloadDoesNotPublish(t *testing.T) {
	var legacy bytes.Buffer
	capture := &nativeTerminalCapturedInput{ch: make(chan []byte, 4)}
	input := newTerminalInputGate(io.Discard, capture)
	output := newTerminalOutputGate(&legacy)
	dest := t.TempDir()
	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: func(ctx context.Context, direction, stage string, inbound io.ReadCloser, outbound io.Writer) error {
			if direction != "receive" { return errors.New("wrong sidecar action") }
			if _, err := io.ReadFull(inbound, make([]byte, nativeZmodemHeaderSize)); err != nil { return err }
			return os.WriteFile(filepath.Join(stage, "partial.bin"), []byte("unverified payload"), 0600)
		},
	}
	done := make(chan error, 1)
	go func() { done <- coordinator.run(context.Background(), "download", dest, "partial.bin") }()
	command := string(nativeTerminalNextInput(t, capture))
	if _, err := output.Write(nativeZmodemHeaderFixture(0)); err != nil { t.Fatal(err) }
	if _, err := output.Write(append(nativeTerminalCompletionFromCommand(t, command, 2), []byte("shell-ready")...)); err != nil { t.Fatal(err) }
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "退出状态为 2") {
			t.Fatalf("missing remote failure status: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("failed download never completed")
	}
	if _, err := os.Stat(filepath.Join(dest, "partial.bin")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed transfer published a partial download: %v", err)
	}
	if _, err := input.Write([]byte("normal")); err != nil {
		t.Fatalf("failed download left terminal leased: %v", err)
	}
	if legacy.String() != "shell-ready" {
		t.Fatalf("failed download did not restore prompt: %q", legacy.String())
	}
}


func TestNativeZmodemRemoteExitBeforeHeaderRestoresTerminal(t *testing.T) {
	var legacy bytes.Buffer
	capture := &nativeTerminalCapturedInput{ch: make(chan []byte, 4)}
	input := newTerminalInputGate(io.Discard, capture)
	output := newTerminalOutputGate(&legacy)
	dest := t.TempDir()
	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: func(ctx context.Context, direction, path string, inbound io.ReadCloser, outbound io.Writer) error {
			if direction != "receive" { return errors.New("wrong sidecar action") }
			<-ctx.Done()
			return ctx.Err()
		},
	}
	done := make(chan error, 1)
	go func() { done <- coordinator.run(context.Background(), "download", dest, "missing-file.bin") }()
	command := string(nativeTerminalNextInput(t, capture))
	marker := nativeTerminalCompletionFromCommand(t, command, 127)
	// The remote command fails without a ZMODEM start frame. The OSC
	// marker is split across arbitrary SSH stdout chunks, then followed
	// by ordinary shell text. No protocol or command echo may leak.
	if _, err := output.Write([]byte("sz: no such file\r\n")); err != nil { t.Fatal(err) }
	for _, part := range [][]byte{marker[:8], marker[8:23], marker[23:]} {
		if _, err := output.Write(part); err != nil { t.Fatal(err) }
	}
	if _, err := output.Write([]byte("shell-ready")); err != nil { t.Fatal(err) }
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "退出状态 127") || !strings.Contains(err.Error(), "安全恢复") {
			t.Fatalf("missing safe early-exit error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("remote early failure left ZMODEM waiting")
	}
	if _, err := input.Write([]byte("pwd")); err != nil {
		t.Fatalf("early remote exit did not restore shell input: %v", err)
	}
	if _, err := output.Write([]byte(" prompt")); err != nil { t.Fatal(err) }
	if got := legacy.String(); got != "shell-ready prompt" {
		t.Fatalf("incorrect replay after early remote exit: %q", got)
	}
}
