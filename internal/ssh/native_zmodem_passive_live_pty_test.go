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

	// Hook installation is now the default whenever the sidecar is configured.
	// The VERIFIED_E2E env only selects the shorter "recovery-focused" case
	// list used by CI; it no longer enables the hook itself.
	verifiedBash := true
	focusRecovery := os.Getenv("OPENSHELL_ZMODEM_PASSIVE_VERIFIED_E2E") == "1"
	largeKiB := 0
	if raw := os.Getenv("OPENSHELL_ZMODEM_PASSIVE_E2E_LARGE_KIB"); raw != "" {
		largeKiB, err = strconv.Atoi(raw)
		if err != nil || largeKiB < 256 || largeKiB > 16384 {
			t.Fatalf("invalid passive E2E large-file size %q (256..16384 KiB)", raw)
		}
	}
	for _, tc := range []struct{
		name string
		direction string
		cancelPicker bool
	}{
		{"remote-sz", "download", false},
		{"remote-rz", "upload", false},
		{"remote-sz-empty", "download", false},
		{"remote-rz-empty", "upload", false},
		{"remote-sz-cancel", "download", true},
		{"remote-rz-cancel", "upload", true},
	} {
		if (largeKiB != 0 || focusRecovery) && (tc.cancelPicker || strings.Contains(tc.name, "empty")) {
			continue // loss/recovery profiles focus on full-size transfers
		}
		t.Run(tc.name, func(t *testing.T) {
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
			terminalOutput := make(chan string, 256)
			manager := NewManager(keys{}, func(name string, payload any) {
				switch name {
				case "ssh:output":
					if p, ok := payload.(map[string]any); ok {
						if raw, ok := p["data"].(string); ok {
							if decoded, err := base64.StdEncoding.DecodeString(raw); err == nil {
								select {case terminalOutput <- string(decoded): default:}
							}
						}
					}
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
			if largeKiB != 0 { payload = nativeLivePayload(largeKiB*1024+43) }
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
			if verifiedBash {
				// Production Manager must install, challenge and acknowledge the
				// Bash hook itself; this E2E no longer installs it manually.
				deadline := time.After(8*time.Second)
				for {
					manager.mu.Lock()
					conn := manager.connections[ref.TabID]
					installed := conn != nil && conn.passiveBashHookToken != "" &&
						!conn.passiveBashHookInstalling && !conn.nativeTerminalPoisoned
					manager.mu.Unlock()
					if installed { break }
					select {
					case <-deadline: t.Fatal("Manager did not automatically install Bash recovery hook")
					case <-time.After(20*time.Millisecond):
					}
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
			if tc.cancelPicker {
				if !manager.ReleaseNativeZmodemSelection(ref, id) {
					t.Fatal("real passive file picker cancellation rejected")
				}
				manager.mu.Lock()
				c := manager.connections[ref.TabID]
				alive := c != nil && c.terminal != nil
				poisoned := c != nil && c.nativeTerminalPoisoned
				manager.mu.Unlock()
				if !alive || poisoned { t.Fatal("verified Bash picker cancellation did not restore the same PTY") }
				if _, err := manager.PassiveZmodemSelection(ref, id); err == nil {
					t.Fatal("cancelled picker still authorized a transfer")
				}
				probe := "printf 'CANCEL_OK_%s\\n' \"$((6*7))\"\r"
				if err := manager.Write(ref, base64.StdEncoding.EncodeToString([]byte(probe))); err != nil {
					t.Fatalf("cancelled picker left SSH input locked: %v", err)
				}
				deadline := time.After(5*time.Second)
				outputTail := ""
				for !strings.Contains(outputTail, "CANCEL_OK_42") {
					select {
					case chunk := <-terminalOutput:
						outputTail += chunk
					case <-deadline:
						t.Fatalf("Bash did not execute next command after cancel: %q", outputTail)
					}
				}
				// Retry the same transfer on the original generation.
				if err := manager.Write(ref, base64.StdEncoding.EncodeToString([]byte(wire))); err != nil { t.Fatal(err) }
				select {
				case retry := <-intents:
					newID, ok := retry["selectionId"].(uint64)
					if !ok || newID <= id || retry["direction"] != tc.direction { t.Fatalf("invalid retry: %v", retry) }
					id = newID
				case <-time.After(12*time.Second):
					t.Fatal("second picker not available after cancel")
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			if verifiedBash {
				var restored bool
				restored, err = manager.RunPassiveNativeZmodemTransferWithResult(
					ctx, ref, id, sidecar, tc.direction, localPath, nil)
				if !restored { t.Fatalf("Manager did not restore original SSH PTY: %v", err) }
			} else {
				err = manager.RunPassiveNativeZmodemTransfer(ctx, ref, id, sidecar, tc.direction, localPath, nil)
			}
			cancel()
			if err != nil { t.Fatalf("real passive %s transfer failed: %v", tc.name, err) }
			if tc.direction == "download" {
				verifyNativeLiveFile(t, filepath.Join(workspace, fileName),
					filepath.Join(localPath, fileName))
			} else {
				verifyNativeLiveFile(t, localPath, filepath.Join(remoteHome, fileName))
			}
			// The Bash prompt may arrive after Rust has closed its stdin.
			// The SSH output gate must keep accepting and quarantining it
			// rather than failing the SSH channel or restoring raw terminal.
			time.Sleep(150 * time.Millisecond)
			manager.mu.Lock()
			c := manager.connections[ref.TabID]
			unsafe := c != nil && c.nativeTerminalPoisoned
			alive := c != nil && c.terminal != nil && c.outputGate != nil
			manager.mu.Unlock()
			if !alive { t.Fatal("post-protocol SSH stdout unexpectedly terminated the PTY") }
			if verifiedBash {
				if unsafe { t.Fatal("verified Bash completion failed to clear SSH poison") }
				// A successful Write call alone does not prove Bash actually
				// executed the next command; test a value not present in the
				// echoed source text, then do a SECOND ZMODEM transfer on the
				// exact same SSH PTY without reconnecting.
				probe := "printf 'RECOVERY_OK_%s\\n' \"$((6*7))\"\r"
				if err := manager.Write(ref, base64.StdEncoding.EncodeToString([]byte(probe))); err != nil {
					t.Fatalf("verified same-PTY terminal rejected next command: %v", err)
				}
				matched := false
				outputTail := ""
				deadline := time.After(5*time.Second)
				for !matched {
					select {
					case chunk := <-terminalOutput:
						outputTail += chunk
						if strings.Contains(outputTail, "RECOVERY_OK_42") {matched=true}
						if len(outputTail)>8192 {outputTail=outputTail[len(outputTail)-8192:]}
					case <-deadline:
						t.Fatalf("Bash did not execute command after native recovery: %q", outputTail)
					}
				}
				secondLocalPath := localPath
				if tc.direction == "download" {
					secondLocalPath = filepath.Join(workspace, "downloaded-again")
					if err := os.Mkdir(secondLocalPath, 0700); err != nil { t.Fatal(err) }
				}
				if err := manager.Write(ref, base64.StdEncoding.EncodeToString([]byte(wire))); err != nil {
					t.Fatalf("second native transfer could not start on recovered PTY: %v", err)
				}
				var secondIntent map[string]any
				select {
				case secondIntent = <-intents:
				case <-time.After(12*time.Second):
					t.Fatal("second passive ZMODEM handshake was not recognized")
				}
				secondID, ok := secondIntent["selectionId"].(uint64)
				if !ok || secondID <= id || secondIntent["direction"] != tc.direction {
					t.Fatalf("second transfer ownership was stale: first=%v second=%v", intent, secondIntent)
				}
				ctx2, cancel2 := context.WithTimeout(context.Background(), 90*time.Second)
				secondSafe, secondErr := manager.RunPassiveNativeZmodemTransferWithResult(
					ctx2, ref, secondID, sidecar, tc.direction, secondLocalPath, nil)
				cancel2()
				if secondErr != nil || !secondSafe {
					t.Fatalf("second transfer did not restore SSH PTY: safe=%v err=%v", secondSafe, secondErr)
				}
				if tc.direction == "download" {
					verifyNativeLiveFile(t,filepath.Join(workspace,fileName),filepath.Join(secondLocalPath,fileName))
				} else {
					verifyNativeLiveFile(t,localPath,filepath.Join(remoteHome,fileName))
				}
				t.Logf("real remote %s: Manager auto-installed Bash, two consecutive native transfers and intervening Bash command succeeded; SHA-256 %x",tc.name,sha256.Sum256(payload))
			} else {
				if !unsafe { t.Fatal("unattested remote exit incorrectly restored PTY") }
				if err := manager.Write(ref, base64.StdEncoding.EncodeToString([]byte("pwd\r")));
					!errors.Is(err, errNativeTerminalInputBusy) {
					t.Fatalf("remote-initiated transfer unexpectedly restored keyboard: %v", err)
				}
				t.Logf("real remote %s: SHA-256 %x; SSH quarantined (segmented TCP delay=%dms)",
					tc.name, sha256.Sum256(payload), delayMS)
			}
		})
	}
}

func nativePassiveShellQuote(raw string) string {
	return "'" + strings.ReplaceAll(raw, "'", "'\\''") + "'"
}
