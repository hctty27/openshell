package main

import (
	"context"
	"path/filepath"
	"runtime"
	"testing"
)

func TestZmodemTransferModeDefaultAndValidation(t *testing.T) {
	want := zmodemModeLegacy
	if runtime.GOOS == "windows" {
		want = zmodemModeNative
	}
	for _, tc := range []struct{ raw, want string }{
		{"", want},
		{"invalid", want},
		{"legacy", "legacy"},
		{"native", "native"},
	} {
		if got := resolveZmodemTransferMode(tc.raw); got != tc.want {
			t.Fatalf("mode %q = %q; want %q", tc.raw, got, tc.want)
		}
	}
}

func TestZmodemTransferModePersistAndImmediateSwitch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	a, err := newApp(path, &vault{m: map[string]string{}}, nil)
	if err != nil { t.Fatal(err) }
	defer a.shutdown(context.Background())

	state, err := a.State()
	if err != nil { t.Fatal(err) }
	if state.ZmodemTransferMode != resolveZmodemTransferMode("") {
		t.Fatalf("unexpected default mode %q", state.ZmodemTransferMode)
	}
	for _, mode := range []string{"legacy", "native", "legacy"} {
		if err := a.SavePreference("zmodemTransferMode", mode); err != nil { t.Fatal(err) }
		if got := a.nativeZmodemPreferred(); got != (mode == zmodemModeNative) {
			t.Fatalf("mode switch %s not applied immediately", mode)
		}
		state, err := a.State()
		if err != nil { t.Fatal(err) }
		if state.ZmodemTransferMode != mode {
			t.Fatalf("State returned %q after saving %q", state.ZmodemTransferMode, mode)
		}
	}
	if err := a.SavePreference("zmodemTransferMode", "automatic"); err == nil {
		t.Fatal("invalid mode should be rejected")
	}
	if a.currentZmodemTransferMode() != zmodemModeLegacy {
		t.Fatal("invalid preference changed active transfer mode")
	}
}

func TestZmodemTransferModePreferenceSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	a, err := newApp(path, &vault{m: map[string]string{}}, nil)
	if err != nil { t.Fatal(err) }
	if err := a.SavePreference("zmodemTransferMode", "legacy"); err != nil { t.Fatal(err) }
	a.shutdown(context.Background())

	b, err := newApp(path, &vault{m: map[string]string{}}, nil)
	if err != nil { t.Fatal(err) }
	defer b.shutdown(context.Background())
	state, err := b.State()
	if err != nil { t.Fatal(err) }
	if state.ZmodemTransferMode != "legacy" || b.nativeZmodemPreferred() {
		t.Fatalf("transfer mode not persisted: %+v", state.ZmodemTransferMode)
	}
}
