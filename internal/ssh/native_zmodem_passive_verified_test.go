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

const testNativePassiveSessionToken = "0123456789abcdef0123456789abcdef"

func TestNativePassiveVerifiedExitRestoresSamePTYAndAllowsNextTransfer(t *testing.T) {
	for _, tc := range []struct {
		name, direction, action string
		frame byte
	}{
		{"remote-rz", "upload", "send", 1},
		{"remote-sz", "download", "receive", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var visible, remoteInput bytes.Buffer
			// Both protocol and ordinary SSH writes reach the same PTY.
			// A io.Discard legacy stub would hide a successfully restored
			// manual command from this assertion.
			input := newTerminalInputGate(&remoteInput, &remoteInput)
			guard := newNativeOnlyOutputGuardPassive(&visible, func() {
				t.Error("valid ZHEX was rejected")
			}, input.blockPassiveInput, func(byte) {})
			output := newTerminalOutputGate(guard)
			header := nativeZmodemHeaderFixture(tc.frame)
			if _, err := output.Write(header); err != nil { t.Fatal(err) }
			local := t.TempDir()
			if tc.direction == "upload" {
				local = filepath.Join(local, "upload.bin")
				if err := os.WriteFile(local, []byte("sample"), 0600); err != nil { t.Fatal(err) }
			}
			finishedRust := make(chan struct{})
			coordinator := &nativeTerminalCoordinator{
				input: input, output: output,
				runner: func(_ context.Context, action, path string, in io.ReadCloser, out io.Writer) error {
					if action != tc.action { return errors.New("wrong sidecar action") }
					protocol := make([]byte, len(header))
					if _, err := io.ReadFull(in, protocol); err != nil { return err }
					if !bytes.Equal(protocol, header) { return errors.New("initial handshake lost") }
					if _, err := out.Write([]byte("local ZMODEM response")); err != nil { return err }
					if tc.direction == "download" {
						if err := os.WriteFile(filepath.Join(path, "download.bin"), []byte("sample"), 0600); err != nil {
							return err
						}
					}
					close(finishedRust)
					return nil
				},
			}
			remoteDone := make(chan error, 1)
			go func() {
				<-finishedRust
				// This marker must have been installed BEFORE remote rz/sz
				// began. It is emitted after Bash observes command exit.
				marker := []byte("\x1b]777;OpenShellNativeZmodem;" +
					testNativePassiveSessionToken + ";0\x07")
				_, err := output.Write(append(marker, []byte("\r\nuser@host:~$ ")...))
				remoteDone <- err
			}()
			restored, err := coordinator.runPassiveVerified(
				context.Background(), tc.direction, local, guard, testNativePassiveSessionToken)
			if err != nil || !restored {
				t.Fatalf("verified shell did not restore PTY: restored=%v err=%v", restored, err)
			}
			if err := <-remoteDone; err != nil { t.Fatal(err) }
			if got := visible.String(); got != "\r\nuser@host:~$ " {
				t.Fatalf("post-marker prompt replay incorrect: %q", got)
			}
			if _, err := input.Write([]byte("pwd\r")); err != nil {
				t.Fatalf("verified terminal refused user input: %v", err)
			}
			if got := remoteInput.String(); got != "local ZMODEM responsepwd\r" {
				t.Fatalf("protocol + user bytes out of order: %q", got)
			}
			if tc.direction == "download" {
				data, err := os.ReadFile(filepath.Join(local, "download.bin"))
				if err != nil || string(data) != "sample" {
					t.Fatalf("verified download was not published: %q %v", data, err)
				}
			}
			// A second remote command should now be eligible for a fresh
			// CRC-verified start frame. The old handshake cannot replay.
			if _, err := output.Write(nativeZmodemHeaderFixture(tc.frame)); err != nil { t.Fatal(err) }
			if _, _, pending := guard.pendingCapture(); !pending {
				t.Fatal("output guard was not reset for the next transfer")
			}
			if _, err := input.Write([]byte("bad")); !errors.Is(err, errNativeTerminalInputBusy) {
				t.Fatalf("second ZMODEM handshake did not lock stdin: %v", err)
			}
		})
	}
}

func TestNativePassiveVerifiedExitRejectsOtherTokenAndKeepsPTYLocked(t *testing.T) {
	var visible bytes.Buffer
	input := newTerminalInputGate(io.Discard, io.Discard)
	guard := newNativeOnlyOutputGuardPassive(&visible, func(){}, input.blockPassiveInput, func(byte){})
	output := newTerminalOutputGate(guard)
	header := nativeZmodemHeaderFixture(1)
	if _, err := output.Write(header); err != nil { t.Fatal(err) }
	local := filepath.Join(t.TempDir(), "sample.bin")
	if err := os.WriteFile(local, []byte("sample"), 0600); err != nil { t.Fatal(err) }
	started := make(chan struct{})
	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: func(_ context.Context, _ string, _ string, in io.ReadCloser, _ io.Writer) error {
			buf := make([]byte, len(header))
			if _, err := io.ReadFull(in, buf); err != nil { return err }
			close(started)
			return nil
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 140*time.Millisecond)
	defer cancel()
	fakeDone := make(chan error, 1)
	go func() {
		<-started
		// A valid-looking OSC from another task/session must not grant
		// permission to resume terminal input.
		fakeDone <- func() error {
			_, err := output.Write([]byte("\x1b]777;OpenShellNativeZmodem;" +
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;0\x07shell$ "))
			return err
		}()
	}()
	restored, err := coordinator.runPassiveVerified(
		ctx, "upload", local, guard, testNativePassiveSessionToken)
	// The upload itself finished, so there is no error; but the terminal
	// must stay locked because the remote shell was never confirmed.
	if restored {
		t.Fatalf("wrong session token restored terminal: restored=%v err=%v", restored, err)
	}
	if err := <-fakeDone; err != nil { t.Fatal(err) }
	if _, err := input.Write([]byte("pwd\r")); !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("wrong token unlocked terminal: %v", err)
	}
	if visible.Len() != 0 {
		t.Fatalf("unverified SSH output leaked into xterm: %q", visible.String())
	}
}

func TestNativePassiveVerifiedExitRejectsUnregisteredToken(t *testing.T) {
	input := newTerminalInputGate(io.Discard, io.Discard)
	coordinator := &nativeTerminalCoordinator{input: input, output: newTerminalOutputGate(io.Discard)}
	restored, err := coordinator.runPassiveVerified(context.Background(), "upload", "/tmp", nil, "")
	if restored || err == nil {
		t.Fatalf("missing pre-registered token accepted: %v %v", restored, err)
	}
}

// B2: in a nested shell (bash -l, sudo -i, su -) the remote never prints the
// registered marker. A file Rust received completely must still be saved;
// only the terminal stays locked until a reconnect.
func TestNativePassiveVerifiedKeepsCompletedDownloadWithoutMarker(t *testing.T) {
	var visible bytes.Buffer
	input := newTerminalInputGate(io.Discard, io.Discard)
	guard := newNativeOnlyOutputGuardPassive(&visible, func(){}, input.blockPassiveInput, func(byte){})
	output := newTerminalOutputGate(guard)
	header := nativeZmodemHeaderFixture(0)
	if _, err := output.Write(header); err != nil { t.Fatal(err) }
	target := t.TempDir()
	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: func(_ context.Context, _ string, dir string, in io.ReadCloser, _ io.Writer) error {
			buf := make([]byte, len(header))
			if _, err := io.ReadFull(in, buf); err != nil { return err }
			return os.WriteFile(filepath.Join(dir, "report.bin"), []byte("complete"), 0600)
		},
	}
	restored, err := coordinator.runPassiveVerified(
		context.Background(), "download", target, guard, testNativePassiveSessionToken)
	if restored || err != nil {
		t.Fatalf("completed download without marker: restored=%v err=%v", restored, err)
	}
	if got, err := os.ReadFile(filepath.Join(target, "report.bin")); err != nil || string(got) != "complete" {
		t.Fatalf("completed download was discarded: %q %v", got, err)
	}
	if _, err := input.Write([]byte("pwd\r")); !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("unverified shell unlocked terminal: %v", err)
	}
}
