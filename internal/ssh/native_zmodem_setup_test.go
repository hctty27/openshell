package sshclient

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/hctty27/openshell/internal/testssh"
	"golang.org/x/crypto/ssh"
)

// TestNativeZmodemSSHSetupDeadline guards the three SSH setup phases that
// previously could block even when an experimental transfer was cancelled.
func TestNativeZmodemSSHSetupDeadline(t *testing.T) {
	for _, test := range []struct {
		mode string
		phase string
	}{
		{"open", "open-channel"},
		{"pty-hang", "request-pty"},
		{"start", "start-exec"},
	} {
		t.Run(test.phase, func(t *testing.T) {
			server := testssh.StartWithMode(t, test.mode)
			client, err := ssh.Dial("tcp", Address(server.Host, server.Port), &ssh.ClientConfig{
				User: "root",
				Auth: []ssh.AuthMethod{ssh.Password("test-password")},
				HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
					if ssh.FingerprintSHA256(key) != server.Fingerprint {
						return errors.New("test SSH host key mismatch")
					}
					return nil
				},
				Timeout: 5 * time.Second,
			})
			if err != nil { t.Fatal(err) }
			defer client.Close()

			ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
			defer cancel()
			started := time.Now()
			err = RunNativeZmodemTransport(ctx, client, "not-started-sidecar", "send", "test.bin", "sleep 30")
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("phase %s did not respect deadline: %v", test.phase, err)
			}
			if elapsed := time.Since(started); elapsed > 2*time.Second {
				t.Fatalf("phase %s blocked after deadline: %v", test.phase, elapsed)
			}
			if test.mode == "pty-hang" {
				// A cancelled experimental PTY must not disconnect the user's
				// authenticated SSH transport or unrelated terminal session.
				other, err := client.NewSession()
				if err != nil { t.Fatalf("SSH connection was closed: %v", err) }
				output, err := other.Output("printf healthy")
				_ = other.Close()
				if err != nil || strings.TrimSpace(string(output)) != "healthy" {
					t.Fatalf("unrelated SSH session failed: %q %v", output, err)
				}
			}
		})
	}
}

func TestNativeZmodemTransportRejectsNilContext(t *testing.T) {
	err := RunNativeZmodemTransport(nil, nil, "sidecar", "send", "file", "command")
	if err == nil || !strings.Contains(err.Error(), "上下文") {
		t.Fatal(fmt.Sprintf("nil context was not rejected: %v", err))
	}
}
