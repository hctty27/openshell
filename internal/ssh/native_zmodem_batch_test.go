package sshclient

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNativeZmodemBatchManifestAndNameSafety(t *testing.T) {
	dir := t.TempDir()
	names := []string{"alpha.bin", "中文 文件.bin", "third.bin"}
	var inputs []string
	for _, name := range names {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(name), 0600); err != nil { t.Fatal(err) }
		inputs = append(inputs, path)
	}
	paths, err := nativeZmodemUploadPaths(inputs)
	if err != nil { t.Fatal(err) }
	manifest, direction, cleanup, err := nativeZmodemUploadManifest(paths)
	if err != nil { t.Fatal(err) }
	if direction != "send-list" { t.Fatalf("expected native batch sender, got %s", direction) }
	payload, err := os.ReadFile(manifest)
	if err != nil { t.Fatal(err) }
	if !bytes.Equal(payload, []byte(strings.Join(paths, "\x00")+"\x00")) {
		t.Fatal("NUL manifest lost Unicode paths or altered file order")
	}
	cleanup()
	if _, err := os.Stat(manifest); !errors.Is(err, os.ErrNotExist) { t.Fatal("sensitive manifest was not removed") }
	_, action, _, err := nativeZmodemUploadManifest(paths[:1])
	if err != nil || action != "send" { t.Fatalf("single transfer changed: %q %v", action, err) }
	if _, err := nativeZmodemUploadPaths([]string{inputs[0], inputs[0]}); err == nil {
		t.Fatal("duplicate destination filename accepted")
	}
	if _, err := nativeZmodemUploadPaths(nil); err == nil { t.Fatal("empty batch accepted") }
	if _, err := nativeZmodemUploadPaths(make([]string, 101)); err == nil { t.Fatal("too many files accepted") }
}

func TestNativeZmodemBatchDownloadCommandEscapesPaths(t *testing.T) {
	raw := "/tmp/report one.bin\n/tmp/中文数据.bin\n/tmp/a'file.bin"
	command, action, err := nativeInteractiveCommand("download", raw)
	if err != nil || action != "receive" { t.Fatalf("batch remote command: %q %v", action, err) }
	if !strings.Contains(command, "sz -q -- ") || !strings.Contains(command, "'/tmp/report one.bin'") ||
		!strings.Contains(command, "'/tmp/a'\\''file.bin'") || strings.Contains(command, "\n") {
		t.Fatalf("batch remote command is not safely shell quoted: %q", command)
	}
	for _, bad := range []string{"", "/tmp/a\n", "safe\nbad\x00name", strings.Repeat("/tmp/a\n", 101)} {
		if _, _, err := nativeInteractiveCommand("download", bad); err == nil {
			t.Fatalf("accepted malformed download list: %q", bad)
		}
	}
}

func TestNativeZmodemBatchPublishAndConflictRollback(t *testing.T) {
	base := t.TempDir()
	stage, dest := filepath.Join(base, "stage"), filepath.Join(base, "dest")
	for _, dir := range []string{stage, dest} {
		if err := os.Mkdir(dir, 0700); err != nil { t.Fatal(err) }
	}
	for _, name := range []string{"alpha.bin", "beta.bin", "中文.txt"} {
		if err := os.WriteFile(filepath.Join(stage, name), []byte(name), 0600); err != nil { t.Fatal(err) }
	}
	if err := os.WriteFile(filepath.Join(dest, "beta.bin"), []byte("existing"), 0600); err != nil { t.Fatal(err) }
	if err := nativeZmodemPublish(stage, dest); err == nil { t.Fatal("batch overwritten an existing file") }
	for _, name := range []string{"alpha.bin", "中文.txt"} {
		if _, err := os.Stat(filepath.Join(dest, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("partial batch was made visible: %s", name)
		}
	}
	if err := os.Remove(filepath.Join(dest, "beta.bin")); err != nil { t.Fatal(err) }
	if err := nativeZmodemPublish(stage, dest); err != nil { t.Fatal(err) }
	for _, name := range []string{"alpha.bin", "beta.bin", "中文.txt"} {
		got, err := os.ReadFile(filepath.Join(dest, name))
		if err != nil || string(got) != name {
			t.Fatalf("batch publish mismatch for %s: %q %v", name, got, err)
		}
	}
}

func TestNativeZmodemInteractiveCoordinatorBatchUsesOnePTYLease(t *testing.T) {
	var terminal bytes.Buffer
	capture := &nativeTerminalCapturedInput{ch: make(chan []byte, 8)}
	input := newTerminalInputGate(io.Discard, capture)
	output := newTerminalOutputGate(&terminal)
	dir := t.TempDir()
	paths := []string{filepath.Join(dir, "first.bin"), filepath.Join(dir, "second.bin")}
	for _, path := range paths {
		if err := os.WriteFile(path, []byte("payload"), 0600); err != nil { t.Fatal(err) }
	}
	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: func(_ context.Context, action, manifest string, inbound io.ReadCloser, outbound io.Writer) error {
			if action != "send-list" { return errors.New("batch did not use manifest mode") }
			data, err := os.ReadFile(manifest)
			if err != nil { return err }
			if !bytes.Equal(data, []byte(strings.Join(paths, "\x00")+"\x00")) {
				return errors.New("batch paths were not ordered correctly")
			}
			if _, err := outbound.Write([]byte("handshake")); err != nil { return err }
			frame := make([]byte, nativeZmodemHeaderSize)
			if _, err := io.ReadFull(inbound, frame); err != nil { return err }
			return nil
		},
	}
	done := make(chan error, 1)
	go func() { done <- coordinator.runBatch(context.Background(), "upload", paths, nil) }()
	command := string(nativeTerminalNextInput(t, capture))
	if !strings.Contains(command, "{ rz -q;") { t.Fatalf("missing one remote rz command: %q", command) }
	header := nativeZmodemHeaderTestStream()
	if _, err := output.Write(header); err != nil { t.Fatal(err) }
	if got := string(nativeTerminalNextInput(t, capture)); got != "handshake" {
		t.Fatalf("native protocol handshake incorrect: %q", got)
	}
	if _, err := output.Write(nativeTerminalCompletionFromCommand(t, command, 0)); err != nil { t.Fatal(err) }
	select {
	case err := <-done:
		if err != nil { t.Fatal(err) }
	case <-time.After(3*time.Second):
		t.Fatal("batch PTY did not restore after remote completion")
	}
	if _, err := input.Write([]byte("next")); err != nil { t.Fatal(err) }
	// Normal input after restoring the PTY is deliberately routed via the
	// legacy filter, not the native control writer.

}

func TestNativeZmodemInteractiveCoordinatorBatchDownloadPublishesAllAfterProof(t *testing.T) {
	var terminal bytes.Buffer
	capture := &nativeTerminalCapturedInput{ch: make(chan []byte, 8)}
	input := newTerminalInputGate(io.Discard, capture)
	output := newTerminalOutputGate(&terminal)
	dest := t.TempDir()
	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: func(_ context.Context, action, stage string, inbound io.ReadCloser, _ io.Writer) error {
			if action != "receive" { return errors.New("wrong batch download mode") }
			if _, err := io.ReadFull(inbound, make([]byte, nativeZmodemHeaderSize)); err != nil { return err }
			for _, name := range []string{"first.bin", "second.bin"} {
				if err := os.WriteFile(filepath.Join(stage, name), []byte(name), 0600); err != nil { return err }
			}
			return nil
		},
	}
	done := make(chan error, 1)
	go func() {
		done <- coordinator.runBatch(context.Background(), "download", []string{dest}, []string{"/tmp/first.bin", "/tmp/second.bin"})
	}()
	command := string(nativeTerminalNextInput(t, capture))
	if !strings.Contains(command, "sz -q -- '/tmp/first.bin' '/tmp/second.bin'") {
		t.Fatalf("remote batch command not quoted correctly: %q", command)
	}
	if _, err := output.Write([]byte("**\x18B000123456789ab")); err != nil { t.Fatal(err) }
	if _, err := os.Stat(filepath.Join(dest, "first.bin")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("batch was published before remote completion")
	}
	if _, err := output.Write(nativeTerminalCompletionFromCommand(t, command, 0)); err != nil { t.Fatal(err) }
	select {
	case err := <-done:
		if err != nil { t.Fatal(err) }
	case <-time.After(3*time.Second): t.Fatal("batch download coordinator stuck")
	}
	for _, name := range []string{"first.bin", "second.bin"} {
		if _, err := os.Stat(filepath.Join(dest, name)); err != nil { t.Fatal(err) }
	}
}
