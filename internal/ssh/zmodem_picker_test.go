package sshclient

import (
    "os"
    "path/filepath"
    "testing"

    "github.com/hctty27/openshell/internal/domain"
)

func newPickerManager(direction string) (*Manager, domain.ConnectionRef, *zmodemSelection) {
    manager := NewManager(nil, nil)
    ref := domain.ConnectionRef{TabID: "tab-1", SessionID: "server-1", Generation: 1}
    request := &zmodemSelection{id: 7, direction: direction, response: make(chan []string, 1)}
    manager.connections[ref.TabID] = &connection{ref: ref, zmodemSelection: request}
    return manager, ref, request
}

func TestZmodemUploadSelectionValidatesFiles(t *testing.T) {
    manager, ref, request := newPickerManager("upload")
    dir := t.TempDir()
    file := filepath.Join(dir, "hello.txt")
    if err := os.WriteFile(file, []byte("hello"), 0600); err != nil {
        t.Fatal(err)
    }
    if err := manager.SubmitZmodemSelection(ref, 7, []string{dir}); err == nil {
        t.Fatal("uploading a directory must be rejected")
    }
    if err := manager.SubmitZmodemSelection(ref, 7, []string{"relative.txt"}); err == nil {
        t.Fatal("relative file path must be rejected")
    }
    if err := manager.SubmitZmodemSelection(ref, 6, []string{file}); err == nil {
        t.Fatal("stale request must be rejected")
    }
    if err := manager.SubmitZmodemSelection(ref, 7, []string{file}); err != nil {
        t.Fatal(err)
    }
    paths := <-request.response
    if len(paths) != 1 || paths[0] != file {
        t.Fatalf("invalid selection: %v", paths)
    }
}

func TestZmodemDownloadRequiresDirectory(t *testing.T) {
    manager, ref, request := newPickerManager("download")
    dir := t.TempDir()
    file := filepath.Join(dir, "a.txt")
    if err := os.WriteFile(file, nil, 0600); err != nil {
        t.Fatal(err)
    }
    if err := manager.SubmitZmodemSelection(ref, 7, []string{file}); err == nil {
        t.Fatal("download target must be a directory")
    }
    if err := manager.SubmitZmodemSelection(ref, 7, []string{dir}); err != nil {
        t.Fatal(err)
    }
    if paths := <-request.response; len(paths) != 1 || paths[0] != dir {
        t.Fatalf("invalid download directory: %v", paths)
    }
}

func TestZmodemCancelAndDisconnectReleaseSelection(t *testing.T) {
    manager, ref, request := newPickerManager("upload")
    if err := manager.SubmitZmodemSelection(ref, 7, nil); err != nil {
        t.Fatal(err)
    }
    if paths := <-request.response; len(paths) != 0 {
        t.Fatalf("cancel should not select files: %v", paths)
    }

    manager, ref, request = newPickerManager("download")
    manager.mu.Lock()
    releaseZmodemSelection(manager.connections[ref.TabID])
    manager.mu.Unlock()
    if paths := <-request.response; len(paths) != 0 {
        t.Fatalf("disconnect should cancel the picker: %v", paths)
    }
}
