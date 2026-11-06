package sshclient

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hctty27/openshell/internal/domain"
	"golang.org/x/crypto/ssh"
)

func TestNativeZmodemRemoteCommandSafety(t *testing.T) {
	remote := "/tmp/a' && touch /tmp/pwned; echo '"
	command, wireDirection, err := nativeZmodemRemoteCommand("upload", remote)
	if err != nil || wireDirection != "send" {
		t.Fatalf("upload command: %q %q %v", command, wireDirection, err)
	}
	if !strings.Contains(command, "'/tmp/a'\\'' && touch /tmp/pwned; echo '\\'''") {
		t.Fatalf("remote path not POSIX-quoted: %s", command)
	}
	command, wireDirection, err = nativeZmodemRemoteCommand("download", remote)
	if err != nil || wireDirection != "receive" || !strings.Contains(command, "exec sz -q -- ") {
		t.Fatalf("download command: %q %q %v", command, wireDirection, err)
	}
	for _, request := range []struct{ direction, path string }{
		{"upload", ""}, {"download", "/tmp/\nnew"}, {"invalid", "/tmp"},
	} {
		if _, _, err := nativeZmodemRemoteCommand(request.direction, request.path); err == nil {
			t.Fatalf("accepted invalid request %+v", request)
		}
	}
}

func TestNativeZmodemLocalPathAndSize(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "中文.bin")
	if err := os.WriteFile(file, []byte("abc"), 0600); err != nil { t.Fatal(err) }
	if _, err := nativeZmodemLocalPath("upload", file); err != nil { t.Fatal(err) }
	if _, err := nativeZmodemLocalPath("download", dir); err != nil { t.Fatal(err) }
	if _, err := nativeZmodemLocalPath("upload", dir); err == nil { t.Fatal("directory upload accepted") }
	if _, err := nativeZmodemLocalPath("download", file); err == nil { t.Fatal("file destination accepted") }
	if _, err := nativeZmodemLocalPath("invalid", file); err == nil { t.Fatal("unknown direction accepted") }

	for _, size := range []int64{128 << 20, 1024 << 20, nativeZmodemMaxFileSize} {
		if err := nativeZmodemCheckFileSize(size); err != nil {
			t.Fatalf("valid size %d rejected: %v", size, err)
		}
	}
	if err := nativeZmodemCheckFileSize(nativeZmodemMaxFileSize + 1); err == nil {
		t.Fatal("oversized upload accepted")
	}
}

func TestNativeZmodemPublishDoesNotOverwriteExistingFiles(t *testing.T) {
	root := t.TempDir()
	stage := filepath.Join(root, "stage")
	target := filepath.Join(root, "destination")
	for _, path := range []string{stage, target} {
		if err := os.Mkdir(path, 0700); err != nil { t.Fatal(err) }
	}
	if err := os.WriteFile(filepath.Join(stage, "data.txt"), []byte("new"), 0600); err != nil { t.Fatal(err) }
	if err := nativeZmodemPublish(stage, target); err != nil { t.Fatal(err) }
	data, err := os.ReadFile(filepath.Join(target, "data.txt"))
	if err != nil || string(data) != "new" { t.Fatalf("publish mismatch: %q, %v", data, err) }
	if err := os.Remove(filepath.Join(stage, "data.txt")); err != nil { t.Fatal(err) }
	if err := os.WriteFile(filepath.Join(stage, "data.txt"), []byte("replace"), 0600); err != nil { t.Fatal(err) }
	if err := nativeZmodemPublish(stage, target); err == nil { t.Fatal("existing target overwritten") }
	data, _ = os.ReadFile(filepath.Join(target, "data.txt"))
	if string(data) != "new" { t.Fatal("destination content changed") }
}

func TestNativeZmodemManagerCancelAndIsolation(t *testing.T) {
	sshManager, ref := connected(t)
	source := filepath.Join(t.TempDir(), "test.bin")
	if err := os.WriteFile(source, []byte("payload"), 0600); err != nil { t.Fatal(err) }
	var eventsMu sync.Mutex
	var events []bool
	manager := NewNativeZmodemManager(sshManager, func(name string, payload any) {
		if name != "ssh:native-zmodem-state" { return }
		eventsMu.Lock()
		events = append(events, payload.(map[string]any)["active"].(bool))
		eventsMu.Unlock()
	}, os.Args[0])
	defer manager.Close()
	started := make(chan struct{})
	manager.transport = func(ctx context.Context, _ *ssh.Client, _, direction, path, command string) error {
		if direction != "send" || path != source || !strings.Contains(command, "exec rz -q") {
			t.Errorf("invalid transfer args: %s %s %s", direction, path, command)
		}
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}
	request := NativeZmodemRequest{Ref: ref, Direction: "upload", LocalPath: source, RemotePath: "/tmp"}
	finished := make(chan error, 1)
	go func() { finished <- manager.Run(context.Background(), request) }()
	select {
	case <-started:
	case <-time.After(5*time.Second): t.Fatal("transfer never started")
	}
	if err := manager.Run(context.Background(), request); err == nil || !strings.Contains(err.Error(), "已经存在") {
		t.Fatalf("concurrent transfer accepted: %v", err)
	}
	old := domain.ConnectionRef{TabID: ref.TabID, SessionID: ref.SessionID, Generation: ref.Generation + 1}
	if manager.Cancel(old) { t.Fatal("stale reference canceled current transfer") }
	if !manager.Cancel(ref) { t.Fatal("cancel rejected active transfer") }
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) { t.Fatalf("cancel should propagate context: %v", err) }
	case <-time.After(5*time.Second): t.Fatal("cancel did not release transfer")
	}
	eventsMu.Lock()
	defer eventsMu.Unlock()
	if len(events) != 2 || !events[0] || events[1] {
		t.Fatalf("unexpected transfer lifecycle events: %v", events)
	}
}

func TestNativeZmodemManagerDownloadStagingCleanup(t *testing.T) {
	sshManager, ref := connected(t)
	destination := t.TempDir()
	manager := NewNativeZmodemManager(sshManager, nil, os.Args[0])
	defer manager.Close()
	manager.transport = func(ctx context.Context, client *ssh.Client, sidecar, direction, stage, command string) error {
		if direction != "receive" { return errors.New("expected receive direction") }
		return os.WriteFile(filepath.Join(stage, "download.bin"), []byte("file body"), 0600)
	}
	req := NativeZmodemRequest{Ref: ref, Direction: "download", LocalPath: destination, RemotePath: "/tmp/download.bin"}
	if err := manager.Run(context.Background(), req); err != nil { t.Fatal(err) }
	data, err := os.ReadFile(filepath.Join(destination, "download.bin"))
	if err != nil || string(data) != "file body" { t.Fatalf("download mismatch: %q, %v", data, err) }
	stage, err := filepath.Glob(filepath.Join(destination, ".openshell-zmodem-native-*"))
	if err != nil || len(stage) != 0 { t.Fatalf("staging directory leaked: %v, %v", stage, err) }
	if err := manager.Run(context.Background(), req); err == nil {
		t.Fatal("second download overwrote an existing file")
	}
}
