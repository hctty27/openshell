package sshclient

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/hctty27/openshell/internal/domain"
	"golang.org/x/crypto/ssh"
)

// This opt-in CI test exercises the REAL interactive terminal created by
// Manager.OpenTerminal, not an isolated SSH exec process. The Linux runner
// starts a loopback OpenSSH daemon with genuine PTY support and real lrzsz.
func TestNativeZmodemLiveInteractivePTY(t *testing.T) {
	if runtime.GOOS != "linux" || os.Getenv("OPENSHELL_ZMODEM_LIVE_PTY") != "1" {
		t.Skip("requires Linux OpenSSH, real PTY, lrzsz, and Rust sidecar")
	}
	address := os.Getenv("OPENSHELL_ZMODEM_LIVE_SSH_ADDR")
	user := os.Getenv("OPENSHELL_ZMODEM_LIVE_SSH_USER")
	keyPath := os.Getenv("OPENSHELL_ZMODEM_LIVE_SSH_KEY")
	hostKeyPath := os.Getenv("OPENSHELL_ZMODEM_LIVE_SSH_HOSTKEY")
	sidecar := os.Getenv("OPENSHELL_ZMODEM_LIVE_SIDECAR")
	if address == "" || user == "" || keyPath == "" || hostKeyPath == "" || sidecar == "" {
		t.Fatal("incomplete Linux real interactive PTY fixture configuration")
	}
	privatePEM, err := os.ReadFile(keyPath)
	if err != nil { t.Fatal(err) }
	signer, err := ssh.ParsePrivateKey(privatePEM)
	if err != nil { t.Fatal(err) }
	hostKeyPEM, err := os.ReadFile(hostKeyPath)
	if err != nil { t.Fatal(err) }
	hostKey, _, _, _, err := ssh.ParseAuthorizedKey(hostKeyPEM)
	if err != nil { t.Fatal(err) }
	client, err := ssh.Dial("tcp", address, &ssh.ClientConfig{
		User: user,
		Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.FixedHostKey(hostKey),
		Timeout: 10 * time.Second,
	})
	if err != nil { t.Fatal(err) }

	ref := domain.ConnectionRef{TabID: "native-live-pty", SessionID: "native-probe", Generation: 1}
	manager := NewManager(keys{}, nil)
	manager.mu.Lock()
	manager.connections[ref.TabID] = &connection{
		ref: ref, client: client, history: NewHistory(1024 * 1024),
	}
	manager.generations[ref.TabID] = ref.Generation
	manager.mu.Unlock()
	t.Cleanup(manager.Close)
	if err := manager.OpenTerminal(ref, 80, 24); err != nil { t.Fatal(err) }

	remoteHome, err := os.UserHomeDir()
	if err != nil { t.Fatal(err) }
	workspace := t.TempDir()
	cases := []struct{ name string; data []byte }{
		{"empty.bin", []byte{}},
		{"binary.bin", nativeLivePayload(64*1024+13)},
		{"中文文件.bin", []byte("OpenShell real PTY/native Rust/lrzsz")},
	}
	for i, item := range cases {
		// Uploads run in the login shell's default working directory, the
		// runner user's HOME. Use an isolated, unique basename and remove
		// both sides even if the CI test fails.
		uploadName := fmt.Sprintf("openshell-native-pty-%d-%s", time.Now().UnixNano()+int64(i), item.name)
		localSource := filepath.Join(workspace, uploadName)
		remoteDest := filepath.Join(remoteHome, uploadName)
		t.Cleanup(func(){ _ = os.Remove(remoteDest) })
		if err := os.WriteFile(localSource, item.data, 0600); err != nil { t.Fatal(err) }
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		err = manager.runNativeTerminalExperiment(ctx, ref, sidecar, "upload", localSource, "")
		cancel()
		if err != nil { t.Fatalf("real interactive PTY upload %q failed: %v", item.name, err) }
		verifyNativeLiveFile(t, localSource, remoteDest)

		// Download a separate remote file by absolute path through the same
		// interactive shell/PTY, verifying that the terminal was restored.
		remoteSource := filepath.Join(workspace, "remote-"+uploadName)
		if err := os.WriteFile(remoteSource, item.data, 0600); err != nil { t.Fatal(err) }
		localDownload := filepath.Join(workspace, fmt.Sprintf("download-%d", i))
		if err := os.Mkdir(localDownload, 0700); err != nil { t.Fatal(err) }
		ctx, cancel = context.WithTimeout(context.Background(), 45*time.Second)
		err = manager.runNativeTerminalExperiment(ctx, ref, sidecar, "download", localDownload, remoteSource)
		cancel()
		if err != nil { t.Fatalf("real interactive PTY download %q failed: %v", item.name, err) }
		verifyNativeLiveFile(t, remoteSource, filepath.Join(localDownload, filepath.Base(remoteSource)))
		t.Logf("real interactive SSH PTY roundtrip %s: upload and download SHA-256 matched", item.name)
	}
	if !manager.Valid(ref) { t.Fatal("successful native transfer disconnected the interactive SSH terminal") }
	// End with normal manual input: both native leases must have been released.
	if err := manager.Write(ref, "cHJpbnRmICdyZXN0b3JlZCdcbg0="); err != nil {
		t.Fatalf("legacy manual input was not restored: %v", err)
	}
}

func nativeLivePayload(size int) []byte {
	out := make([]byte, size)
	for i := range out { out[i] = byte((i*197+17)%256) }
	return out
}

func verifyNativeLiveFile(t *testing.T, source, target string) {
	t.Helper()
	expected, err := os.ReadFile(source)
	if err != nil { t.Fatal(err) }
	got, err := os.ReadFile(target)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) { t.Fatalf("real SSH PTY transfer did not create %q", target) }
		t.Fatal(err)
	}
	if sha256.Sum256(expected) != sha256.Sum256(got) ||
		!bytes.Equal(expected, got) {
		t.Fatalf("real SSH PTY transfer data mismatch: %q -> %q", source, target)
	}
}
