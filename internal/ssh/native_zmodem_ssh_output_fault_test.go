package sshclient

import (
	"bytes"
	"errors"
	"io"
	"testing"
)

// A Rust-sidecar protocol fault belongs to the native transfer task. It must
// never become an error on ssh.Session.Stdout, where it could terminate the
// live SSH terminal while ordinary Shell output is still in flight.
func TestNativeZmodemSinkFailureDoesNotAbortSSHStdout(t *testing.T) {
	for _, tc := range []struct {
		name       string
		frame      byte
		closeInput bool
		wantClosed bool
	}{
		{name: "mismatched download header", frame: 1, closeInput: false},
		{name: "download reader closed", frame: 0, closeInput: true, wantClosed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var visible bytes.Buffer
			reader, writer := io.Pipe()
			defer reader.Close()
			defer writer.Close()
			if tc.closeInput {
				if err := reader.Close(); err != nil {
					t.Fatal(err)
				}
			}
			sink := &nativeTerminalInboundSink{
				pipe: writer, ready: make(chan struct{}),
				fail: make(chan error, 1), expected: '0',
			}
			output := newTerminalOutputGate(&visible)
			lease, err := output.takeover(sink)
			if err != nil {
				t.Fatal(err)
			}

			header := nativeZmodemHeaderFixture(tc.frame)
			if n, err := output.Write(header); err != nil || n != len(header) {
				t.Fatalf("native fault propagated to SSH stdout: n=%d, err=%v", n, err)
			}
			select {
			case failure := <-sink.fail:
				if failure == nil {
					t.Fatal("missing native task failure")
				}
				if tc.wantClosed && !errors.Is(failure, io.ErrClosedPipe) {
					t.Fatalf("expected closed protocol pipe, got %v", failure)
				}
			default:
				t.Fatal("protocol fault was not delivered to native coordinator")
			}

			// Once the protocol is unsafe, even ordinary Shell bytes must be
			// kept away from xterm and must not abort the SSH stdout copier.
			for _, chunk := range [][]byte{
				[]byte("late ZMODEM bytes"),
				[]byte("shell prompt must stay quarantined"),
			} {
				if n, err := output.Write(chunk); err != nil || n != len(chunk) {
					t.Fatalf("subsequent SSH stdout write failed: n=%d, err=%v", n, err)
				}
			}
			if visible.Len() != 0 {
				t.Fatalf("unverified protocol reached xterm: %q", visible.String())
			}
			if err := output.quarantineNative(lease); err != nil {
				t.Fatalf("failed to isolate native output after fault: %v", err)
			}
			if n, err := output.Write([]byte("more shell output")); err != nil ||
				n != len("more shell output") {
				t.Fatalf("SSH stdout failed after quarantine: n=%d, err=%v", n, err)
			}
			if visible.Len() != 0 {
				t.Fatalf("output escaped isolation: %q", visible.String())
			}
		})
	}
}
