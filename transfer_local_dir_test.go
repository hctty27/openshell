package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/hctty27/openshell/internal/domain"
)

func TestTransferLocalDirectoryPreferences(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.db")
	a, err := newApp(statePath, &vault{m: map[string]string{}}, nil)
	if err != nil { t.Fatal(err) }
	first, err := a.SaveSession(SaveSessionRequest{Session: domain.Session{Name: "first", Host: "localhost", Port: 22, Username: "root", AuthType: "password"}})
	if err != nil { t.Fatal(err) }
	second, err := a.SaveSession(SaveSessionRequest{Session: domain.Session{Name: "second", Host: "localhost", Port: 22, Username: "root", AuthType: "password"}})
	if err != nil { t.Fatal(err) }

	global := filepath.Join(t.TempDir(), "global")
	local := filepath.Join(t.TempDir(), "session")
	if err = os.Mkdir(global, 0700); err != nil { t.Fatal(err) }
	if err = os.Mkdir(local, 0700); err != nil { t.Fatal(err) }
	if err = a.SetTransferDefaultLocalDir(global); err != nil { t.Fatal(err) }
	if dir, err := a.GetTransferLocalDir(first.ID); err != nil || dir != global {
		t.Fatalf("session should inherit global directory: %q %v", dir, err)
	}
	if err = a.SaveTransferLocalDir(first.ID, local); err != nil { t.Fatal(err) }
	if dir, err := a.GetTransferLocalDir(first.ID); err != nil || dir != local {
		t.Fatalf("session directory was not saved: %q %v", dir, err)
	}
	if dir, err := a.GetTransferLocalDir(second.ID); err != nil || dir != global {
		t.Fatalf("other session must stay independent: %q %v", dir, err)
	}
	duplicated, err := a.DuplicateSession(first.ID)
	if err != nil { t.Fatal(err) }
	if dir, err := a.GetTransferLocalDir(duplicated.ID); err != nil || dir != local {
		t.Fatalf("duplicated session should inherit the saved directory: %q %v", dir, err)
	}
	if err = a.SaveTransferLocalDir(duplicated.ID, global); err != nil { t.Fatal(err) }
	if dir, _ := a.GetTransferLocalDir(first.ID); dir != local {
		t.Fatalf("duplicate must not mutate source session: %q", dir)
	}

	a.shutdown(context.Background())
	a, err = newApp(statePath, &vault{m: map[string]string{}}, nil)
	if err != nil { t.Fatal(err) }
	defer a.shutdown(context.Background())
	if dir, err := a.GetTransferLocalDir(first.ID); err != nil || dir != local {
		t.Fatalf("session directory did not survive restart: %q %v", dir, err)
	}
	if err = os.Remove(local); err != nil { t.Fatal(err) }
	if dir, err := a.GetTransferLocalDir(first.ID); err != nil || dir != global {
		t.Fatalf("removed session directory should fall back: %q %v", dir, err)
	}
	if err = a.SaveTransferLocalDir(first.ID, local); err == nil {
		t.Fatal("missing local directory was accepted")
	}
	if err = a.SetTransferDefaultLocalDir(filepath.Join(global, "missing")); err == nil {
		t.Fatal("missing global directory was accepted")
	}
	if err = a.DeleteSession(first.ID); err != nil { t.Fatal(err) }
	if raw, err := a.store.GetPreference(a.ctx, transferSessionLocalDirPrefix+first.ID); err != nil || raw != "" {
		t.Fatalf("deleted session kept its local directory: %q %v", raw, err)
	}
	if err = a.SetTransferDefaultLocalDir(""); err != nil { t.Fatal(err) }
	if dir, err := a.GetTransferDefaultLocalDir(); err != nil || dir == "" {
		t.Fatalf("expected home directory after clearing global default: %q %v", dir, err)
	}
}
