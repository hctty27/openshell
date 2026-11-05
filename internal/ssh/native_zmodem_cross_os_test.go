package sshclient

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hctty27/openshell/internal/domain"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// This optional test uses real SSH + a genuine Linux PTY and SFTP. Unlike
// Linux-only localhost fixtures it shares NO filesystem with the SSH server.
// It runs unchanged on Windows with a Windows Rust sidecar and a Linux host.
func TestNativeZmodemCrossOSInteractivePTY(t *testing.T) {
	if os.Getenv("OPENSHELL_ZMODEM_CROSS_OS_PTY") != "1" {
		t.Skip("requires explicitly configured Linux OpenSSH + SFTP + lrzsz")
	}
	get := func(k string) string {
		v := os.Getenv(k)
		if v == "" { t.Fatalf("missing %s", k) }
		return v
	}
	address := get("OPENSHELL_ZMODEM_LIVE_SSH_ADDR")
	user := get("OPENSHELL_ZMODEM_LIVE_SSH_USER")
	keyPEM, err := os.ReadFile(get("OPENSHELL_ZMODEM_LIVE_SSH_KEY"))
	if err != nil { t.Fatal(err) }
	signer, err := ssh.ParsePrivateKey(keyPEM)
	if err != nil { t.Fatal(err) }
	hostPEM, err := os.ReadFile(get("OPENSHELL_ZMODEM_LIVE_SSH_HOSTKEY"))
	if err != nil { t.Fatal(err) }
	hostKey, _, _, _, err := ssh.ParseAuthorizedKey(hostPEM)
	if err != nil { t.Fatal(err) }
	sidecar := get("OPENSHELL_ZMODEM_LIVE_SIDECAR")
	if stat, err := os.Stat(sidecar); err != nil || !stat.Mode().IsRegular() {
		t.Fatalf("sidecar is not a regular file: %q, %v", sidecar, err)
	}
	delayMS := 0
	if raw := os.Getenv("OPENSHELL_ZMODEM_CROSS_OS_LATENCY_MS"); raw != "" {
		delayMS, err = strconv.Atoi(raw)
		if err != nil || delayMS < 0 || delayMS > 10 { t.Fatalf("invalid test latency %q", raw) }
	}
	socket, err := net.DialTimeout("tcp", address, 10*time.Second)
	if err != nil { t.Fatal(err) }
	var transport net.Conn = socket
	if delayMS > 0 {
		transport = &nativeCrossOSDelayedConn{Conn: socket, delay: time.Duration(delayMS)*time.Millisecond}
	}
	sshConn, chans, requests, err := ssh.NewClientConn(transport, address, &ssh.ClientConfig{
		User: user, Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.FixedHostKey(hostKey), Timeout: 10*time.Second,
	})
	if err != nil { _ = socket.Close(); t.Fatal(err) }
	client := ssh.NewClient(sshConn, chans, requests)
	sftpClient, err := sftp.NewClient(client)
	if err != nil { _ = client.Close(); t.Fatalf("Linux fixture needs SFTP: %v", err) }

	session, err := client.NewSession()
	if err != nil { t.Fatal(err) }
	remoteInfo, err := session.Output("uname -s; printf '%s' \"$HOME\"")
	_ = session.Close()
	if err != nil { t.Fatal(err) }
	lines := strings.SplitN(strings.TrimSpace(string(remoteInfo)), "\n", 2)
	if len(lines) != 2 || lines[0] != "Linux" || !strings.HasPrefix(lines[1], "/") {
		t.Fatalf("target must be a Linux server with absolute HOME, got %q", remoteInfo)
	}
	remoteHome := strings.TrimSpace(lines[1])
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil { t.Fatal(err) }
	id := hex.EncodeToString(nonce[:])
	stage := path.Join(remoteHome, ".openshell-zmodem-cross-"+id)
	if err := sftpClient.Mkdir(stage); err != nil { t.Fatal(err) }
	var remoteFiles []string
	// Register cleanup before manager.Close: the SSH client must stay open
	// until all cleanup transfers have completed.
	t.Cleanup(func() {
		for _, p := range remoteFiles { _ = sftpClient.Remove(p) }
		_ = sftpClient.RemoveDirectory(stage)
		_ = sftpClient.Close()
		_ = client.Close()
	})

	ref := domain.ConnectionRef{TabID: "cross-os-pty", SessionID: "native-cross-os", Generation: 1}
	manager := NewManager(keys{}, nil)
	manager.mu.Lock()
	manager.connections[ref.TabID] = &connection{ref: ref, client: client, history: NewHistory(1024*1024)}
	manager.generations[ref.TabID] = ref.Generation
	manager.mu.Unlock()
	t.Cleanup(manager.Close)
	if err := manager.OpenTerminal(ref, 80, 24); err != nil { t.Fatal(err) }

	root := t.TempDir()
	cases := []struct { name string; bytes []byte }{
		{"empty.bin", nil},
		{"binary.bin", nativeLivePayload(64*1024+13)},
		{"中文文件.bin", []byte("cross-host native Rust and Linux lrzsz")},
		{"large.bin", nativeLivePayload(4*1024*1024+37)},
	}
	for i, item := range cases {
		name := fmt.Sprintf("openshell-%s-%s", id, item.name)
		localSource := filepath.Join(root, name)
		if err := os.WriteFile(localSource, item.bytes, 0600); err != nil { t.Fatal(err) }
		remoteTarget := path.Join(remoteHome, name)
		remoteFiles = append(remoteFiles, remoteTarget)
		ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
		err := manager.runNativeTerminalExperiment(ctx, ref, sidecar, "upload", localSource, "")
		cancel()
		if err != nil { t.Fatalf("upload %s: %v", name, err) }
		remoteReader, err := sftpClient.Open(remoteTarget)
		if err != nil { t.Fatal(err) }
		hash, hashErr := nativeCrossOSDigest(remoteReader)
		_ = remoteReader.Close()
		if hashErr != nil || hash != sha256.Sum256(item.bytes) {
			t.Fatalf("upload checksum mismatch %s: %v", name, hashErr)
		}

		sourceName := "source-"+item.name
		remoteSource := path.Join(stage, sourceName)
		remoteFiles = append(remoteFiles, remoteSource)
		remoteWriter, err := sftpClient.Create(remoteSource)
		if err != nil { t.Fatal(err) }
		_, writeErr := io.Copy(remoteWriter, bytes.NewReader(item.bytes))
		closeErr := remoteWriter.Close()
		if writeErr != nil { t.Fatal(writeErr) }
		if closeErr != nil { t.Fatal(closeErr) }
		localDir := filepath.Join(root, fmt.Sprintf("download-%d", i))
		if err := os.Mkdir(localDir, 0700); err != nil { t.Fatal(err) }
		ctx, cancel = context.WithTimeout(context.Background(), 75*time.Second)
		err = manager.runNativeTerminalExperiment(ctx, ref, sidecar, "download", localDir, remoteSource)
		cancel()
		if err != nil { t.Fatalf("download %s: %v", sourceName, err) }
		download, err := os.Open(filepath.Join(localDir, sourceName))
		if err != nil { t.Fatal(err) }
		hash, hashErr = nativeCrossOSDigest(download)
		_ = download.Close()
		if hashErr != nil || hash != sha256.Sum256(item.bytes) {
			t.Fatalf("download checksum mismatch %s: %v", sourceName, hashErr)
		}
		t.Logf("cross-host real Linux PTY: %s upload+download SHA-256 match (latency %dms)", item.name, delayMS)
	}
	if err := manager.Write(ref, "cHJpbnRmICd0ZXJtaW5hbC1yZXN0b3JlZCcNCg=="); err != nil {
		t.Fatalf("legacy terminal did not restore: %v", err)
	}
}

func nativeCrossOSDigest(reader io.Reader) ([32]byte, error) {
	h := sha256.New()
	_, err := io.Copy(h, reader)
	var digest [32]byte
	copy(digest[:], h.Sum(nil))
	return digest, err
}

const nativeCrossOSChunk = 16 * 1024
// TCP stream delay + segmentation is a reproducible weak-link proxy but
// does NOT pretend to emulate real IP packet loss or retransmissions.
type nativeCrossOSDelayedConn struct {
	net.Conn
	delay time.Duration
	writeMu sync.Mutex
}
func (c *nativeCrossOSDelayedConn) Read(p []byte) (int, error) {
	if len(p) > nativeCrossOSChunk { p = p[:nativeCrossOSChunk] }
	n, err := c.Conn.Read(p)
	if n > 0 { time.Sleep(c.delay) }
	return n, err
}
func (c *nativeCrossOSDelayedConn) Write(p []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	total := 0
	for len(p) > 0 {
		chunk := p
		if len(chunk) > nativeCrossOSChunk { chunk = chunk[:nativeCrossOSChunk] }
		n, err := c.Conn.Write(chunk)
		total += n
		p = p[n:]
		if err != nil { return total, err }
		if n == 0 { return total, io.ErrShortWrite }
		time.Sleep(c.delay)
	}
	return total, nil
}
