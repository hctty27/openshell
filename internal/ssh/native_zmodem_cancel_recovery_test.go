package sshclient

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A cancelled transfer must not force a reconnect when the exact remote
// command proves it has exited. Never restore based only on local process exit.
func TestNativeZmodemCancelledTransferRestoresAfterRemoteProof(t *testing.T) {
	var legacy bytes.Buffer
	capture := &nativeTerminalCapturedInput{ch: make(chan []byte, 8)}
	input := newTerminalInputGate(io.Discard, capture)
	output := newTerminalOutputGate(&legacy)
	source := filepath.Join(t.TempDir(), "single.bin")
	if err := os.WriteFile(source, []byte("test"), 0600); err != nil { t.Fatal(err) }
	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: func(ctx context.Context, action, path string, inbound io.ReadCloser, outbound io.Writer) error {
			if action != "send" || path != source { return errors.New("invalid sidecar arguments") }
			if _, err := io.ReadFull(inbound, make([]byte, nativeZmodemHeaderSize)); err != nil { return err }
			<-ctx.Done()
			return ctx.Err()
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- coordinator.run(ctx, "upload", source, "") }()
	command := string(nativeTerminalNextInput(t, capture))
	if _, err := output.Write(nativeZmodemHeaderTestStream()); err != nil { t.Fatal(err) }
	cancel()
	select {
	case protocolCancel := <-capture.ch:
		if !bytes.Equal(protocolCancel, zmodemCancelSequence) {
			t.Fatalf("ZMODEM cancel frame mismatch: %x", protocolCancel)
		}
	case <-time.After(4*time.Second):
		t.Fatal("cancellation did not notify the remote protocol")
	}
	if _, err := output.Write(append(nativeTerminalCompletionFromCommand(t, command, 1), []byte("shell-ready")...)); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || err == nil {
			t.Fatalf("cancel result lost: %v", err)
		}
		if !bytes.Contains([]byte(err.Error()), []byte("终端已安全恢复")) {
			t.Fatalf("cancel still demanded reconnection: %v", err)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("cancelled transfer did not release terminal after remote proof")
	}
	if _, err := input.Write([]byte("normal shell input")); err != nil {
		t.Fatalf("terminal input was not safely restored: %v", err)
	}
	if _, err := output.Write([]byte(" prompt")); err != nil { t.Fatal(err) }
	if legacy.String() != "shell-ready prompt" {
		t.Fatalf("unexpected protocol data leaked into the terminal: %q", legacy.String())
	}
}
