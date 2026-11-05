package sshclient

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// This test runs only when CI supplies actual native Windows binaries.
// The test SSH fixture accepts a real encrypted SSH session and PTY request;
// it executes lrzsz-win32 through a subprocess, without emulating a Win32 PTY.
func TestWindowsNativeZmodemSSHInterop(t *testing.T) {
	if runtime.GOOS != "windows" || os.Getenv("OPENSHELL_ZMODEM_WINDOWS_E2E") != "1" {
		t.Skip("requires Windows Rust sidecar and verified lrzsz-win32 test fixtures")
	}
	sidecar := os.Getenv("OPENSHELL_ZMODEM_SIDECAR_PATH")
	peerDir := os.Getenv("OPENSHELL_ZMODEM_LRZSZ_NATIVE_DIR")
	if sidecar == "" || peerDir == "" {
		t.Fatal("missing Windows ZMODEM interoperability executable paths")
	}
	for _, path := range []string{sidecar, filepath.Join(peerDir, "rz.exe"),
		filepath.Join(peerDir, "sz.exe"), filepath.Join(peerDir, "msys-2.0.dll")} {
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			t.Fatalf("required test binary unavailable: %q: %v", path, err)
		}
	}
	// Only the external test peer uses lrzsz-win32/MSYS2. OpenShell itself
	// loads neither and the local sender/receiver is the native Rust EXE.
	t.Setenv("PATH", peerDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	manager, ref := connected(t)
	client, err := manager.Client(ref)
	if err != nil { t.Fatal(err) }

	// testssh runs the remote command in the Go package's working directory.
	// Relative paths avoid mixing Windows drive letters with POSIX sh quoting.
	workspace, err := os.MkdirTemp(".", ".openshell-native-ssh-")
	if err != nil { t.Fatal(err) }
	t.Cleanup(func() { _ = os.RemoveAll(workspace) })
	dir := filepath.Base(workspace)
	remoteUpload := filepath.Join(workspace, "remote-upload")
	remoteSend := filepath.Join(workspace, "remote-send")
	localUpload := filepath.Join(workspace, "local-upload")
	localDownload := filepath.Join(workspace, "local-download")
	for _, path := range []string{remoteUpload, remoteSend, localUpload, localDownload} {
		if err := os.Mkdir(path, 0700); err != nil { t.Fatal(err) }
	}

	cases := []struct{
		name string
		payload []byte
	}{
		{"empty.bin", []byte{}},
		{"one.bin", []byte{0x7f}},
		{"binary.bin", zmodemInteropPayload(64*1024+13)},
		{"中文文件.bin", []byte("UTF-8 filename through Windows Go SSH and Rust")},
		{"large.bin", zmodemInteropPayload(1024*1024+37)},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			source := filepath.Join(localUpload, item.name)
			if err := os.WriteFile(source, item.payload, 0600); err != nil { t.Fatal(err) }

			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			uploadCmd := fmt.Sprintf("cd %s/remote-upload && exec rz.exe -q -y", dir)
			if err := RunNativeZmodemTransport(ctx, client, sidecar, "send", source, uploadCmd); err != nil {
				t.Fatalf("Windows native sender -> lrzsz-win32 over SSH: %v", err)
			}
			checkZmodemInteropHash(t, source, filepath.Join(remoteUpload, item.name))

			remoteSource := filepath.Join(remoteSend, item.name)
			if err := os.WriteFile(remoteSource, item.payload, 0600); err != nil { t.Fatal(err) }
			remoteCmd := fmt.Sprintf("cd %s/remote-send && exec sz.exe -q -- %s", dir, shellQuoteZmodemInterop(item.name))
			if err := RunNativeZmodemTransport(ctx, client, sidecar, "receive", localDownload, remoteCmd); err != nil {
				t.Fatalf("lrzsz-win32 -> Windows native receiver over SSH: %v", err)
			}
			checkZmodemInteropHash(t, remoteSource, filepath.Join(localDownload, item.name))
		})
	}
}

func zmodemInteropPayload(size int) []byte {
	result := make([]byte, size)
	for i := range result { result[i] = byte((i*197+17)%256) }
	return result
}

func shellQuoteZmodemInterop(name string) string {
	return "'" + strings.ReplaceAll(name, "'", "'\\''") + "'"
}

func checkZmodemInteropHash(t *testing.T, source, received string) {
	t.Helper()
	expected, err := os.ReadFile(source)
	if err != nil { t.Fatal(err) }
	got, err := os.ReadFile(received)
	if err != nil { t.Fatal(err) }
	if sha256.Sum256(expected) != sha256.Sum256(got) {
		t.Fatalf("SHA-256 differs: %q -> %q", source, received)
	}
}
