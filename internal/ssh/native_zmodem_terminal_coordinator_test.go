package sshclient

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
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
	proof := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- coordinator.run(context.Background(), "upload", file, "", proof) }()

	if got := string(nativeTerminalNextInput(t, capture)); got != "rz -q\r" {
		t.Fatalf("unexpected explicit command %q", got)
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
	if legacy.String() != "shell>" { t.Fatalf("binary bytes leaked into legacy: %q", legacy.String()) }
	select {
	case err := <-done:
		t.Fatalf("restored terminal without verified remote boundary: %v", err)
	case <-time.After(30*time.Millisecond):
	}
	close(proof)
	select {
	case err := <-done:
		if err != nil { t.Fatal(err) }
	case <-time.After(3*time.Second):
		t.Fatal("remote completion did not restore terminal")
	}
	if _, err := input.Write([]byte("normal")); err != nil { t.Fatal(err) }
	if _, err := output.Write([]byte("prompt")); err != nil { t.Fatal(err) }
	if got := legacy.String(); got != "shell>prompt" {
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
	proof := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- coordinator.run(context.Background(), "download", dest, "a'b.txt", proof) }()
	if got := string(nativeTerminalNextInput(t, capture)); got != "sz -q -- 'a'\\''b.txt'\r" {
		t.Fatalf("unsafe or wrong remote shell command %q", got)
	}
	// Remote ZRQINIT denotes a download, not ZRINIT.
	header := []byte("**\x18B000123456789ab")
	if len(header) != nativeZmodemHeaderSize { t.Fatal("invalid ZRQINIT fixture") }
	if _, err := output.Write(header[:3]); err != nil { t.Fatal(err) }
	if _, err := output.Write(header[3:]); err != nil { t.Fatal(err) }
	if _, err := os.Stat(filepath.Join(dest, "result.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("received file published before remote completion proof: %v", err)
	}
	close(proof)
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
	go func() { done <- coordinator.run(ctx, "upload", file, "", make(chan struct{})) }()
	_ = nativeTerminalNextInput(t, capture)
	// ZRQINIT (download) must not be mistaken for upload's ZRINIT.
	_, _ = output.Write([]byte("**\x18B000123456789ab"))
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
	go func() { done <- coordinator.run(ctx, "upload", file, "", make(chan struct{})) }()
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
	for _, item := range []struct{ direction, remote string }{
		{"download", ""}, {"download", "/tmp/new\nline"}, {"invalid", "x"},
	} {
		if _, _, err := nativeInteractiveCommand(item.direction, item.remote); err == nil {
			t.Fatalf("accepted invalid remote command: %+v", item)
		}
	}
	for _, item := range []struct{ direction, remote, command, action string }{
		{"upload", "", "rz -q\r", "send"},
		{"download", "x y", "sz -q -- 'x y'\r", "receive"},
	} {
		cmd, action, err := nativeInteractiveCommand(item.direction, item.remote)
		if err != nil || cmd != item.command || action != item.action {
			t.Fatalf("invalid generated command: %q %q %v", cmd, action, err)
		}
	}
	var legacy bytes.Buffer
	input := newTerminalInputGate(io.Discard, io.Discard)
	output := newTerminalOutputGate(&legacy)
	c := &nativeTerminalCoordinator{input: input, output: output,
		runner: func(context.Context, string, string, io.ReadCloser, io.Writer) error { return nil }}
	if err := c.run(context.Background(), "upload", "/does-not-exist", "", nil); err == nil {
		t.Fatal("accepted missing completion proof")
	}
	if err := c.run(nil, "upload", "/does-not-exist", "", make(chan struct{})); err == nil {
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
	go func() { done <- coordinator.run(ctx, "upload", file, "", make(chan struct{})) }()
	_ = nativeTerminalNextInput(t, capture)
	if err := coordinator.run(context.Background(), "upload", file, "", make(chan struct{})); !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("overlapping native coordinator accepted: %v", err)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3*time.Second): t.Fatal("primary transfer did not cancel")
	}
}
