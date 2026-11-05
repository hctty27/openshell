package sshclient

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestNativeZmodemInterruptedDownloadRemovesPartialFiles(t *testing.T) {
	for _, variant := range []string{"cancel-connection", "close-manager", "deadline"} {
		t.Run(variant, func(t *testing.T) {
			sshManager, ref := connected(t)
			destination := t.TempDir()
			manager := NewNativeZmodemManager(sshManager, nil, os.Args[0])
			defer manager.Close()

			stageReady := make(chan struct{})
			var once sync.Once
			manager.transport = func(ctx context.Context, _ *ssh.Client, _, direction, stage, _ string) error {
				if direction != "receive" { t.Errorf("expected receive, got %s", direction) }
				if err := os.WriteFile(filepath.Join(stage, "partial.bin"), []byte("incomplete"), 0600); err != nil {
					return err
				}
				once.Do(func() { close(stageReady) })
				<-ctx.Done()
				return ctx.Err()
			}
			ctx := context.Background()
			var cancel context.CancelFunc = func(){}
			if variant == "deadline" {
				ctx, cancel = context.WithTimeout(ctx, 250*time.Millisecond)
			}
			defer cancel()
			request := NativeZmodemRequest{
				Ref: ref,
				Direction: "download",
				LocalPath: destination,
				RemotePath: "/tmp/partial.bin",
			}
			done := make(chan error, 1)
			go func() { done <- manager.Run(ctx, request) }()
			select {
			case <-stageReady:
			case <-time.After(5*time.Second):
				t.Fatal("download never entered staging")
			}
			switch variant {
			case "cancel-connection":
				manager.CancelConnection(ref)
			case "close-manager":
				manager.Close()
			}
			select {
			case err := <-done:
				expected := context.Canceled
				if variant == "deadline" { expected = context.DeadlineExceeded }
				if !errors.Is(err, expected) {
					t.Fatalf("unexpected interruption error %v, want %v", err, expected)
				}
			case <-time.After(5*time.Second):
				t.Fatal("interrupted transfer failed to finish")
			}
			entries, err := os.ReadDir(destination)
			if err != nil { t.Fatal(err) }
			if len(entries) != 0 {
				t.Fatalf("partial files or temporary directory leaked: %v", entries)
			}
			manager.mu.Lock()
			active := len(manager.active)
			manager.mu.Unlock()
			if active != 0 { t.Fatalf("active transfer leaked: %d", active) }
		})
	}
}
