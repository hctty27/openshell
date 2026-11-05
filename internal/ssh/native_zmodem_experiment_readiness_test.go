package sshclient

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/hctty27/openshell/internal/domain"
)

func TestNativeZmodemExperimentalReadinessRequiresExplicitOptIn(t *testing.T) {
	m, ref := connected(t)
	if err := m.OpenTerminal(ref, 80, 24); err != nil { t.Fatal(err) }
	status := m.NativeZmodemExperimentalReadiness(ref, filepath.Join(t.TempDir(), "not-present"), false)
	if status.Ready || status.Code != "disabled" {
		t.Fatalf("disabled experiment was exposed: %+v", status)
	}
	if status := m.NativeZmodemExperimentalReadiness(ref, "", true); status.Code != "sidecar_missing" {
		t.Fatalf("missing native executable was not rejected: %+v", status)
	}
	if status := m.NativeZmodemExperimentalReadiness(ref, filepath.Join(t.TempDir(), "absent.exe"), true); status.Code != "sidecar_invalid" {
		t.Fatalf("absent sidecar was not rejected: %+v", status)
	}
}

func TestNativeZmodemExperimentalReadinessChecksTerminalAndLeases(t *testing.T) {
	m, ref := connected(t)
	executable, err := filepath.Abs(os.Args[0])
	if err != nil { t.Fatal(err) }
	before := m.NativeZmodemExperimentalReadiness(ref, executable, true)
	if before.Code != "no_connection" && before.Code != "sidecar_invalid" {
		t.Fatalf("unopened terminal reported ready: %+v", before)
	}
	if err := m.OpenTerminal(ref, 80, 24); err != nil { t.Fatal(err) }
	current := m.NativeZmodemExperimentalReadiness(ref, executable, true)
	if !current.Ready || current.Code != "ready" {
		t.Fatalf("valid experimental terminal not ready: %+v", current)
	}
	stale := domain.ConnectionRef{TabID: ref.TabID, SessionID: ref.SessionID, Generation: ref.Generation + 1}
	if got := m.NativeZmodemExperimentalReadiness(stale, executable, true); got.Code != "no_connection" {
		t.Fatalf("stale connection generation allowed: %+v", got)
	}
	m.mu.Lock()
	c := m.connections[ref.TabID]
	c.nativeTerminalPoisoned = true
	m.mu.Unlock()
	if got := m.NativeZmodemExperimentalReadiness(ref, executable, true); got.Code != "needs_reconnect" {
		t.Fatalf("failed native transfer not gated: %+v", got)
	}
	m.mu.Lock()
	c.nativeTerminalPoisoned = false
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.nativeTerminalTransfer = &nativeTerminalTransferTask{ref: ref, cancel: cancel}
	m.mu.Unlock()
	if got := m.NativeZmodemExperimentalReadiness(ref, executable, true); got.Code != "busy" {
		t.Fatalf("concurrent transfer not gated: %+v", got)
	}
	m.mu.Lock()
	c.nativeTerminalTransfer = nil
	m.mu.Unlock()
}

func TestNativeZmodemExperimentalReadinessRejectsLinkedSidecar(t *testing.T) {
	m, ref := connected(t)
	if err := m.OpenTerminal(ref, 80, 24); err != nil { t.Fatal(err) }
	source := filepath.Join(t.TempDir(), "sidecar")
	if runtime.GOOS == "windows" { source += ".exe" }
	if err := os.WriteFile(source, []byte("dummy"), 0700); err != nil { t.Fatal(err) }
	link := filepath.Join(t.TempDir(), filepath.Base(source))
	if err := os.Symlink(source, link); err != nil {
		t.Skipf("test environment does not permit symlinks: %v", err)
	}
	if status := m.NativeZmodemExperimentalReadiness(ref, link, true); status.Code != "sidecar_invalid" {
		t.Fatalf("linked executable should not be trusted: %+v", status)
	}
}

func TestNativeZmodemExperimentalReadinessNeverStartsTransfer(t *testing.T) {
	m, ref := connected(t)
	if err := m.OpenTerminal(ref, 80, 24); err != nil { t.Fatal(err) }
	executable, _ := filepath.Abs(os.Args[0])
	if status := m.NativeZmodemExperimentalReadiness(ref, executable, true); !status.Ready {
		t.Fatalf("expected dry-run ready: %+v", status)
	}
	m.mu.Lock()
	c := m.connections[ref.TabID]
	active := c.nativeTerminalTransfer
	m.mu.Unlock()
	if active != nil {
		t.Fatal("read-only readiness check unexpectedly started a native transfer")
	}
}
