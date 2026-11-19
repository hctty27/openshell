package sshclient

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestNativeZmodemPublishRejectsMultipleReceivedFiles(t *testing.T) {
	base := t.TempDir()
	stage, destination := filepath.Join(base, "stage"), filepath.Join(base, "dest")
	for _, dir := range []string{stage, destination} {
		if err := os.Mkdir(dir, 0700); err != nil { t.Fatal(err) }
	}
	if err := nativeZmodemPublish(stage, destination); err == nil {
		t.Fatal("empty transfer was incorrectly published")
	}
	for _, name := range []string{"first.bin", "second.bin"} {
		if err := os.WriteFile(filepath.Join(stage, name), []byte(name), 0600); err != nil { t.Fatal(err) }
	}
	if err := nativeZmodemPublish(stage, destination); err == nil {
		t.Fatal("remote multi-file transfer was incorrectly published")
	}
	for _, name := range []string{"first.bin", "second.bin"} {
		if _, err := os.Stat(filepath.Join(destination, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("an unconfirmed multi-file transfer published %s", name)
		}
	}
	if err := os.Remove(filepath.Join(stage, "second.bin")); err != nil { t.Fatal(err) }
	if err := nativeZmodemPublish(stage, destination); err != nil { t.Fatal(err) }
	if data, err := os.ReadFile(filepath.Join(destination, "first.bin")); err != nil || string(data) != "first.bin" {
		t.Fatalf("confirmed single file was not published: %q %v", data, err)
	}
}
