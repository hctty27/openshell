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

func TestNativePassiveCoordinatorBridgesExistingRemoteProcess(t *testing.T) {
	for _, tc := range []struct{
		name string
		frame byte
		direction string
		action string
	}{
		{"remote-rz-upload", 1, "upload", "send"},
		{"remote-sz-download", 0, "download", "receive"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var visible, outbound bytes.Buffer
			input := newTerminalInputGate(io.Discard, &outbound)
			guard := newNativeOnlyOutputGuardPassive(&visible, func() {
				t.Error("valid remote start fell back to unsupported mode")
			}, input.blockPassiveInput, func(byte) {})
			gate := newTerminalOutputGate(guard)
			header := nativeZmodemHeaderFixture(tc.frame)
			remoteData := append(append([]byte(nil), header...), []byte("remote-payload")...)
			for _, chunk := range [][]byte{remoteData[:5], remoteData[5:13], remoteData[13:]} {
				if _, err := gate.Write(chunk); err != nil { t.Fatal(err) }
			}
			local := t.TempDir()
			if tc.direction == "upload" {
				local = filepath.Join(local, "source.bin")
				if err := os.WriteFile(local, []byte("source"), 0600); err != nil { t.Fatal(err) }
			}
			coordinator := &nativeTerminalCoordinator{
				input: input, output: gate,
				runner: func(ctx context.Context, action, path string, in io.ReadCloser, out io.Writer) error {
					if action != tc.action { return errors.New("wrong sidecar action") }
					if _, err := out.Write([]byte("local-handshake")); err != nil { return err }
					buf := make([]byte, len(remoteData))
					if _, err := io.ReadFull(in, buf); err != nil { return err }
					if !bytes.Equal(buf, remoteData) { return errors.New("initial ZHEX or subsequent data lost") }
					if tc.direction == "download" {
						if err := os.WriteFile(filepath.Join(path, "received.bin"), []byte("verified"), 0600); err != nil { return err }
					}
					return nil
				},
			}
			if err := coordinator.runPassive(context.Background(), tc.direction, local, guard); err != nil {
				t.Fatal(err)
			}
			if outbound.String() != "local-handshake" {
				t.Fatalf("native control not delivered to same remote PTY: %q", outbound.String())
			}
			if visible.Len() != 0 { t.Fatalf("protocol leaked to terminal: %x", visible.Bytes()) }
			if _, err := input.Write([]byte("pwd")); !errors.Is(err, errNativeTerminalInputBusy) {
				t.Fatalf("unverified shell was falsely restored: %v", err)
			}
			if tc.direction == "download" {
				data, err := os.ReadFile(filepath.Join(local, "received.bin"))
				if err != nil || string(data) != "verified" {
					t.Fatalf("successful native download was not published: %q %v", data, err)
				}
			}
		})
	}
}


func TestNativePassiveGenericOSC133633FinishDoesNotRestoreShell(t *testing.T) {
  for _, marker := range []string{
    "\x1b]133;D;0\x07",
    "\x1b]633;D;0\x1b\\",
  } {
    t.Run(marker, func(t *testing.T) {
      var visible, remoteInput bytes.Buffer
      input := newTerminalInputGate(io.Discard, &remoteInput)
      guard := newNativeOnlyOutputGuardPassive(&visible, func(){},
        input.blockPassiveInput, func(byte){})
      output := newTerminalOutputGate(guard)
      header := nativeZmodemHeaderFixture(1)
      if _, err := output.Write(header); err != nil { t.Fatal(err) }
      localPath := filepath.Join(t.TempDir(), "upload.txt")
      if err := os.WriteFile(localPath, []byte("ok"), 0600); err != nil { t.Fatal(err) }
      coordinator := &nativeTerminalCoordinator{
        input: input, output: output,
        runner: func(_ context.Context, direction, path string, in io.ReadCloser, out io.Writer) error {
          if direction != "send" || path != localPath { return errors.New("invalid native action") }
          buf := make([]byte, len(header))
          if _, err := io.ReadFull(in, buf); err != nil { return err }
          if !bytes.Equal(header, buf) { return errors.New("wrong handshake bytes") }
          return nil
        },
      }
      if err := coordinator.runPassive(context.Background(), "upload", localPath, guard); err != nil {
        t.Fatal(err)
      }
      // Unauthenticated integration text may be emitted by applications or
      // a child process and must never be interpreted as PTY completion.
      if _, err := output.Write(append([]byte(marker), []byte("shell> ")...)); err != nil {
        t.Fatal(err)
      }
      if visible.Len() != 0 {
        t.Fatalf("unsolicited completion text leaked into xterm: %x", visible.Bytes())
      }
      if _, err := input.Write([]byte("pwd\r")); !errors.Is(err, errNativeTerminalInputBusy) {
        t.Fatalf("plain OSC sequence released terminal ownership: %v", err)
      }
    })
  }
}


func TestNativePassiveCancelAfterHandoffDoesNotPublishOrRestoreShell(t *testing.T) {
	var visible, remoteInput bytes.Buffer
	input := newTerminalInputGate(io.Discard, &remoteInput)
	guard := newNativeOnlyOutputGuardPassive(&visible, func(){},
		input.blockPassiveInput, func(byte){})
	output := newTerminalOutputGate(guard)
	header := nativeZmodemHeaderFixture(0)
	if _, err := output.Write(header); err != nil { t.Fatal(err) }
	destination := t.TempDir()
	started := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: func(ctx context.Context, direction, path string, in io.ReadCloser, out io.Writer) error {
			if direction != "receive" { return errors.New("expected local ZMODEM receiver") }
			buf := make([]byte, len(header))
			if _, err := io.ReadFull(in, buf); err != nil { return err }
			if !bytes.Equal(buf, header) { return errors.New("initial frame lost") }
			// A partial download staged on disk must not be published.
			if err := os.WriteFile(filepath.Join(path, "incomplete.bin"), []byte("partial"), 0600); err != nil {
				return err
			}
			close(started)
			<-ctx.Done()
			return ctx.Err()
		},
	}
	result := make(chan error, 1)
	go func() { result <- coordinator.runPassive(ctx, "download", destination, guard) }()
	select {
	case <-started:
	case <-time.After(3*time.Second): t.Fatal("sidecar never received handshake")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected cancelled passive transfer, got %v", err)
		}
	case <-time.After(5*time.Second): t.Fatal("cancelled sidecar hung")
	}
	if _, err := os.Stat(filepath.Join(destination, "incomplete.bin")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("partial passive download was published: %v", err)
	}
	if _, err := input.Write([]byte("pwd\r")); !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("cancelled passive transfer unlocked SSH: %v", err)
	}
	if visible.Len() != 0 { t.Fatalf("cancelled protocol exposed binary to terminal: %x", visible.Bytes()) }
}
