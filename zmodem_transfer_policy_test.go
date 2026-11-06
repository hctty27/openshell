package main

import (
	"context"
	"path/filepath"
	"runtime"
	"testing"
)

func expectedZmodemTransferMode() string {
	if runtime.GOOS == "windows" {
		return zmodemModeNative
	}
	return zmodemModeLegacy
}

func TestZmodemTransferModeIsFixedByPlatform(t *testing.T) {
	t.Setenv("OPENSHELL_NATIVE_ZMODEM_SIDECAR", "")
	want := expectedZmodemTransferMode()
	for _, raw := range []string{"", "invalid", "legacy", "native"} {
		if got := resolveZmodemTransferMode(raw); got != want {
			t.Fatalf("saved mode %q changed platform policy to %q; want %q", raw, got, want)
		}
	}
}

func TestLegacyZmodemPreferenceIsIgnoredAfterRestart(t *testing.T) {
	t.Setenv("OPENSHELL_NATIVE_ZMODEM_SIDECAR", "")
	path := filepath.Join(t.TempDir(), "state.db")
	a, err := newApp(path, &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.store.SetPreference(a.ctx, "zmodemTransferMode", "legacy"); err != nil {
		t.Fatal(err)
	}
	a.shutdown(context.Background())

	b, err := newApp(path, &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer b.shutdown(context.Background())
	if got, want := b.currentZmodemTransferMode(), expectedZmodemTransferMode(); got != want {
		t.Fatalf("stale preference restored mode %q; want %q", got, want)
	}
}

func TestZmodemTransferModeCannotBeChangedThroughPreference(t *testing.T) {
	t.Setenv("OPENSHELL_NATIVE_ZMODEM_SIDECAR", "")
	a, err := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.shutdown(context.Background())

	before := a.currentZmodemTransferMode()
	if err := a.SavePreference("zmodemTransferMode", "legacy"); err == nil {
		t.Fatal("obsolete ZMODEM engine preference should be rejected")
	}
	if got := a.currentZmodemTransferMode(); got != before {
		t.Fatalf("obsolete preference changed engine from %q to %q", before, got)
	}
}
