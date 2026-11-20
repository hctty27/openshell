package sshclient

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
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
