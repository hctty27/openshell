package sshclient

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os"
	"path"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/hctty27/openshell/internal/domain"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// Real OpenSSH + actual Rust sidecar + Linux sz; this is NOT a mock of the
// PTY or a separate SSH exec transfer. It intentionally disconnects or
// cancels an in-progress multi-megabyte transfer.
//
// It is also runnable from a native Windows Go test process against a
// dedicated Linux SSH fixture. GitHub's Linux run is not Windows evidence.
func TestNativeZmodemLiveInterruptedInteractivePTY(t *testing.T) {
	if os.Getenv("OPENSHELL_ZMODEM_CROSS_OS_PTY") != "1" {
		t.Skip("requires opted-in OpenSSH + SFTP + Linux lrzsz fixture")
	}
	if runtime.GOOS != "linux" && runtime.GOOS != "windows" {
		t.Skip("only supported on Linux or Windows native clients")
	}
	read := func(key string) string {
		value := os.Getenv(key)
		if value == "" { t.Fatalf("missing %s", key) }
		return value
	}
	address := read("OPENSHELL_ZMODEM_LIVE_SSH_ADDR")
	user := read("OPENSHELL_ZMODEM_LIVE_SSH_USER")
	sidecar := read("OPENSHELL_ZMODEM_LIVE_SIDECAR")
	key, err := os.ReadFile(read("OPENSHELL_ZMODEM_LIVE_SSH_KEY"))
	if err != nil { t.Fatal(err) }
	signer, err := ssh.ParsePrivateKey(key)
	if err != nil { t.Fatal(err) }
	hostBytes, err := os.ReadFile(read("OPENSHELL_ZMODEM_LIVE_SSH_HOSTKEY"))
	if err != nil { t.Fatal(err) }
	hostKey, _, _, _, err := ssh.ParseAuthorizedKey(hostBytes)
	if err != nil { t.Fatal(err) }

	config := &ssh.ClientConfig{
		User: user,
		Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.FixedHostKey(hostKey),
		Timeout: 10*time.Second,
	}
	dialSSH := func(delayed bool) (*ssh.Client, error) {
		raw, err := net.DialTimeout("tcp", address, 10*time.Second)
		if err != nil { return nil, err }
		var transport net.Conn = raw
		if delayed {
			transport = &nativeCrossOSDelayedConn{Conn: raw, delay: 8*time.Millisecond}
		}
		conn, chans, requests, err := ssh.NewClientConn(transport, address, config)
		if err != nil { _ = raw.Close(); return nil, err }
		return ssh.NewClient(conn, chans, requests), nil
	}
	// Keep a separate SSH connection for remote fixture cleanup even after
	// the transfer's main SSH transport is deliberately destroyed.
	cleanupClient, err := dialSSH(false)
	if err != nil { t.Fatal(err) }
	defer cleanupClient.Close()
	cleanupSFTP, err := sftp.NewClient(cleanupClient)
	if err != nil { t.Fatal(err) }
	defer cleanupSFTP.Close()

	remoteSession, err := cleanupClient.NewSession()
	if err != nil { t.Fatal(err) }
	homeBytes, err := remoteSession.Output("printf '%s' \"$HOME\"")
	_ = remoteSession.Close()
	if err != nil { t.Fatal(err) }
	home := strings.TrimSpace(string(homeBytes))
	if !strings.HasPrefix(home, "/") { t.Fatalf("unexpected remote HOME: %q", home) }

	payload := nativeLivePayload(32 * 1024 * 1024)
	for _, kind := range []string{"cancel", "deadline", "disconnect"} {
		t.Run(kind, func(t *testing.T) {
			var nonce [8]byte
			if _, err := rand.Read(nonce[:]); err != nil { t.Fatal(err) }
			remoteSource := path.Join(home, ".openshell-native-fault-"+hex.EncodeToString(nonce[:])+".bin")
			remote, err := cleanupSFTP.Create(remoteSource)
			if err != nil { t.Fatal(err) }
			_, copyErr := io.Copy(remote, bytes.NewReader(payload))
			closeErr := remote.Close()
			if copyErr != nil { t.Fatal(copyErr) }
			if closeErr != nil { t.Fatal(closeErr) }
			t.Cleanup(func() { _ = cleanupSFTP.Remove(remoteSource) })

			client, err := dialSSH(true)
			if err != nil { t.Fatal(err) }
			ref := domain.ConnectionRef{TabID: "fault-"+kind, SessionID: "native-interruption", Generation: 1}
			manager := NewManager(keys{}, nil)
			manager.mu.Lock()
			manager.connections[ref.TabID] = &connection{
				ref: ref, client: client, history: NewHistory(512*1024),
			}
			manager.generations[ref.TabID] = ref.Generation
			manager.mu.Unlock()
			t.Cleanup(manager.Close)
			if err := manager.OpenTerminal(ref, 80, 24); err != nil { t.Fatal(err) }

			ctx := context.Background()
			cancel := func() {}
			if kind == "deadline" {
				ctx, cancel = context.WithTimeout(ctx, 3*time.Second)
			} else {
				ctx, cancel = context.WithCancel(ctx)
			}
			defer cancel()
			localDir := t.TempDir()
			done := make(chan error, 1)
			go func() {
				done <- manager.runNativeTerminalExperiment(ctx, ref, sidecar, "download", localDir, remoteSource)
			}()
			// A lease only proves the coordinator has started. Wait until
			// the real SSH PTY has actually delivered the remote ZRQINIT
			// frame to the native protocol sink.
			deadline := time.Now().Add(7*time.Second)
			var connRecord *connection
			for {
				manager.mu.Lock()
				connRecord = manager.connections[ref.TabID]
				manager.mu.Unlock()
				if connRecord != nil && connRecord.outputGate != nil {
					connRecord.outputGate.mu.Lock()
					active := connRecord.outputGate.native != nil
					connRecord.outputGate.mu.Unlock()
					if active { break }
				}
				select {
				case err := <-done:
					t.Fatalf("transfer ended before live ZMODEM start (%s): %v", kind, err)
				default:
				}
				if time.Now().After(deadline) {
					cancel()
					t.Fatal("remote ZMODEM header did not reach the real interactive PTY")
				}
				time.Sleep(10*time.Millisecond)
			}

			switch kind {
			case "cancel":
				if !manager.CancelExperimentalNativeTerminalTransfer(ref) {
					t.Fatal("failed to cancel active native transfer")
				}
			case "disconnect":
				_ = client.Close()
			}
			select {
			case err := <-done:
				if err == nil { t.Fatal("interrupted native transfer reported success") }
				if kind == "cancel" && !errors.Is(err, context.Canceled) {
					t.Fatalf("cancel did not propagate: %v", err)
				}
				if kind == "deadline" && !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("deadline did not propagate: %v", err)
				}
				t.Logf("real SSH/PTy %s interrupted correctly: %v", kind, err)
			case <-time.After(8*time.Second):
				t.Fatal("native sidecar or SSH reader did not finish after interruption")
			}
			manager.mu.Lock()
			remaining := connRecord.nativeTerminalTransfer
			poisoned := connRecord.nativeTerminalPoisoned
			manager.mu.Unlock()
			if remaining != nil || !poisoned {
				t.Fatalf("failed terminal cleanup: task=%v poisoned=%v", remaining != nil, poisoned)
			}
			if _, err := manager.AcquireAITerminal(ref); err == nil {
				t.Fatal("AI obtained terminal input after unsafe native interruption")
			}
			if err := manager.runNativeTerminalExperiment(context.Background(), ref, sidecar, "download", localDir, remoteSource); err == nil {
				t.Fatal("unsafe SSH terminal accepted another native transfer")
			}
			files, err := os.ReadDir(localDir)
			if err != nil { t.Fatal(err) }
			if len(files) != 0 {
				t.Fatalf("cancelled download published a partial file: %d entries", len(files))
			}
			if kind != "disconnect" {
				// Only the PTY becomes unsafe; a healthy SSH transport and
				// unrelated SFTP channel should still work until reconnect.
				unrelated, err := sftp.NewClient(client)
				if err != nil { t.Fatalf("cancel closed shared SSH transport: %v", err) }
				_, err = unrelated.Stat(remoteSource)
				_ = unrelated.Close()
				if err != nil { t.Fatalf("unrelated SFTP channel died: %v", err) }
			}
		})
	}
}
