package sshclient

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/hctty27/openshell/internal/domain"
	"golang.org/x/crypto/ssh"
)

// This is an opt-in end-to-end test against a REAL OpenSSH PTY with genuine
// lrzsz and the packaged Rust sidecar. It intentionally bypasses the local
// literal "rz/sz" interception by submitting a bash -c command, then checks
// that the unsolicited remote handshake is handed to the native sidecar.
func TestNativeZmodemPassiveLiveInteractivePTY(t *testing.T) {
	if runtime.GOOS != "linux" || os.Getenv("OPENSHELL_ZMODEM_PASSIVE_E2E") != "1" {
		t.Skip("requires isolated Linux sshd, lrzsz and native Rust sidecar")
	}
	address := os.Getenv("OPENSHELL_ZMODEM_LIVE_SSH_ADDR")
	user := os.Getenv("OPENSHELL_ZMODEM_LIVE_SSH_USER")
	keyPath := os.Getenv("OPENSHELL_ZMODEM_LIVE_SSH_KEY")
	hostPath := os.Getenv("OPENSHELL_ZMODEM_LIVE_SSH_HOSTKEY")
	sidecar := os.Getenv("OPENSHELL_ZMODEM_LIVE_SIDECAR")
	if address == "" || user == "" || keyPath == "" || hostPath == "" || sidecar == "" {
		t.Fatal("incomplete live SSH passive fixture configuration")
	}
	privatePEM, err := os.ReadFile(keyPath)
	if err != nil { t.Fatal(err) }
	signer, err := ssh.ParsePrivateKey(privatePEM)
	if err != nil { t.Fatal(err) }
	hostPEM, err := os.ReadFile(hostPath)
	if err != nil { t.Fatal(err) }
	hostKey, _, _, _, err := ssh.ParseAuthorizedKey(hostPEM)
	if err != nil { t.Fatal(err) }
	remoteHome, err := os.UserHomeDir()
	if err != nil { t.Fatal(err) }
	// Delayed segmented TCP is a reproducible slow-link proxy. It does not
	// emulate dropped packets or the kernel's retransmission behavior.
	delayMS := 0
	if raw := os.Getenv("OPENSHELL_ZMODEM_PASSIVE_E2E_DELAY_MS"); raw != "" {
		delayMS, err = strconv.Atoi(raw)
		if err != nil || delayMS < 0 || delayMS > 10 {
			t.Fatalf("invalid passive SSH test latency %q", raw)
		}
	}

	for _, tc := range []struct{
		name string
		direction string
	}{
		{"remote-sz", "download"},
		{"remote-rz", "upload"},
		{"remote-sz-empty", "download"},
		{"remote-rz-empty", "upload"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("OPENSHELL_ZMODEM_PASSIVE_EXPERIMENT", "1")
			socket, err := net.DialTimeout("tcp", address, 10*time.Second)
			if err != nil { t.Fatal(err) }
			var transport net.Conn = socket
			if delayMS > 0 {
				transport = &nativeCrossOSDelayedConn{
					Conn: socket, delay: time.Duration(delayMS)*time.Millisecond,
				}
			}
			sshConn, channels, requests, err := ssh.NewClientConn(transport, address, &ssh.ClientConfig{
				User: user, Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)},
				HostKeyCallback: ssh.FixedHostKey(hostKey), Timeout: 10*time.Second,
			})
			if err != nil { _ = socket.Close(); t.Fatal(err) }
			client := ssh.NewClient(sshConn, channels, requests)
			ref := domain.ConnectionRef{
				TabID: "passive-e2e-" + tc.name, SessionID: "passive-e2e",
				Generation: 1,
			}
			intents := make(chan map[string]any, 4)
			unsupported := make(chan string, 4)
			manager := NewManager(keys{}, func(name string, payload any) {
				switch name {
				case "ssh:native-zmodem-auto-intent":
					if p, ok := payload.(map[string]any); ok {
						select { case intents <- p: default: }
					}
				case "ssh:native-zmodem-unsupported":
					if p, ok := payload.(map[string]any); ok {
						if message, ok := p["error"].(string); ok {
							select { case unsupported <- message: default: }
						}
					}
				}
			})
			manager.ConfigureNativeZmodemAuto(sidecar)
			manager.mu.Lock()
			manager.connections[ref.TabID] = &connection{
				ref: ref, client: client, history: NewHistory(1024*1024),
			}
			manager.generations[ref.TabID] = ref.Generation
			manager.mu.Unlock()
			t.Cleanup(manager.Close)
			if err := manager.OpenTerminal(ref, 80, 24); err != nil { t.Fatal(err) }

			workspace := t.TempDir()
			payload := nativeLivePayload(64*1024+43)
			if strings.Contains(tc.name, "empty") { payload = nil }
			fileName := fmt.Sprintf("openshell-passive-%s-%d.bin", tc.name, time.Now().UnixNano())
			localPath := ""
			var remoteCommand string
			if tc.direction == "download" {
				remoteFile := filepath.Join(workspace, fileName)
				if err := os.WriteFile(remoteFile, payload, 0600); err != nil { t.Fatal(err) }
				localPath = filepath.Join(workspace, "downloaded")
				if err := os.Mkdir(localPath, 0700); err != nil { t.Fatal(err) }
				remoteCommand = "sz -q -- " + nativePassiveShellQuote(remoteFile)
			} else {
				localPath = filepath.Join(workspace, fileName)
				if err := os.WriteFile(localPath, payload, 0600); err != nil { t.Fatal(err) }
				remoteFile := filepath.Join(remoteHome, fileName)
				t.Cleanup(func(){ _ = os.Remove(remoteFile) })
				remoteCommand = "rz -q -y"
			}
			// Give the login shell a chance to print its initial prompt.
			// This is for test fixture startup, NOT for deciding PTY recovery.
			readyDeadline := time.After(5*time.Second)
			for {
				manager.mu.Lock()
				c := manager.connections[ref.TabID]
				manager.mu.Unlock()
				if c == nil { t.Fatal("SSH session closed before initial prompt") }
				_, ready := c.readiness.nativeZmodemInputState()
				if ready { break }
				select {
				case <-readyDeadline:
					t.Fatal("live SSH shell never became ready")
				case <-time.After(20*time.Millisecond):
				}
			}
			// The input begins with bash, so OpenShell cannot replace it
			// with its literal-command Ctrl-U / re-exec path.
			wire := "bash -c " + nativePassiveShellQuote(remoteCommand) + "\r"
			if err := manager.Write(ref, base64.StdEncoding.EncodeToString([]byte(wire))); err != nil {
				t.Fatalf("could not start remote shell command: %v", err)
			}
			var intent map[string]any
			select {
			case intent = <-intents:
			case message := <-unsupported:
				t.Fatalf("remote %s was rejected before file picker: %s", tc.name, message)
			case <-time.After(12*time.Second):
				t.Fatal("remote-initiated ZMODEM handshake was not detected")
			}
			id, ok := intent["selectionId"].(uint64)
			if !ok || id == 0 || intent["passive"] != true ||
				intent["direction"] != tc.direction {
				t.Fatalf("invalid passive handshake intent: %v", intent)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			err = manager.RunPassiveNativeZmodemTransfer(ctx, ref, id, sidecar, tc.direction, localPath, nil)
			cancel()
			if err != nil { t.Fatalf("real passive %s transfer failed: %v", tc.name, err) }
			if tc.direction == "download" {
				verifyNativeLiveFile(t, filepath.Join(workspace, fileName),
					filepath.Join(localPath, fileName))
			} else {
				verifyNativeLiveFile(t, localPath, filepath.Join(remoteHome, fileName))
			}
			manager.mu.Lock()
			c := manager.connections[ref.TabID]
			unsafe := c != nil && c.nativeTerminalPoisoned
			manager.mu.Unlock()
			if !unsafe { t.Fatal("unattested remote exit incorrectly restored PTY") }
			if err := manager.Write(ref, base64.StdEncoding.EncodeToString([]byte("pwd\r")));
				!errors.Is(err, errNativeTerminalInputBusy) {
				t.Fatalf("remote-initiated transfer unexpectedly restored keyboard: %v", err)
			}
			t.Logf("real remote %s: local and remote SHA-256 %x; SSH remains quarantined (segmented TCP delay=%dms)",
				tc.name, sha256.Sum256(payload), delayMS)
		})
	}
}

func nativePassiveShellQuote(raw string) string {
	return "'" + strings.ReplaceAll(raw, "'", "'\\''") + "'"
}
