package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/hctty27/openshell/internal/domain"
)

func TestNativeZmodemInteractiveDesktopUsesFixedPlatformPolicy(t *testing.T) {
	t.Setenv("OPENSHELL_NATIVE_ZMODEM_SIDECAR", "")
	a, err := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.shutdown(context.Background())

	wantEnabled := runtime.GOOS == "windows"
	if got := a.nativeZmodemPreferred(); got != wantEnabled {
		t.Fatalf("native transfer enabled=%v; want %v on %s", got, wantEnabled, runtime.GOOS)
	}
	if err := a.SavePreference("zmodemTransferMode", "legacy"); err == nil {
		t.Fatal("obsolete compatibility preference should be rejected")
	}
	if got := a.nativeZmodemPreferred(); got != wantEnabled {
		t.Fatalf("obsolete preference changed fixed platform policy to %v", got)
	}

	ref := domain.ConnectionRef{TabID: "tab", SessionID: "test", Generation: 1}
	status := a.NativeZmodemInteractiveReadiness(ref)
	if !wantEnabled {
		if status.Ready || status.Code != "disabled" {
			t.Fatalf("native transfer unexpectedly enabled outside supported platform: %+v", status)
		}
		if err := a.StartNativeZmodemInteractiveTransfer(ref, "upload", "source", ""); err == nil {
			t.Fatal("unsupported platform accepted a native transfer")
		}
		if err := a.CancelNativeZmodemInteractiveTransfer(ref); err == nil {
			t.Fatal("unsupported platform allowed native cancellation")
		}
		if _, err := a.NativeZmodemChooseUploadFile(); err == nil {
			t.Fatal("unsupported platform exposed the native file chooser")
		}
	} else if status.Code == "disabled" {
		t.Fatalf("Windows native transfer was disabled: %+v", status)
	}
}

func TestNativeZmodemInteractiveDesktopRequiresExactActiveTerminal(t *testing.T) {
	executable, err := filepath.Abs(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENSHELL_NATIVE_ZMODEM_SIDECAR", executable)
	a, err := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.shutdown(context.Background())
	if !a.nativeZmodemPreferred() {
		t.Fatal("explicit native sidecar did not enable the native test path")
	}
	ref := domain.ConnectionRef{TabID: "missing", SessionID: "missing", Generation: 1}
	status := a.NativeZmodemInteractiveReadiness(ref)
	if status.Ready || status.Code != "no_connection" {
		t.Fatalf("missing SSH terminal unexpectedly ready: %+v", status)
	}
	if err := a.StartNativeZmodemInteractiveTransfer(ref, "download", t.TempDir(), "/tmp/missing"); err == nil {
		t.Fatal("missing SSH terminal accepted a transfer")
	}
	if err := a.CancelNativeZmodemInteractiveTransfer(ref); err == nil {
		t.Fatal("no active native transfer to cancel")
	}

	const fake = "chosen-native-test.txt"
	a.pickNativeZmodemFile = func() (string, error) { return fake, nil }
	path, err := a.NativeZmodemChooseUploadFile()
	if err != nil || path != fake {
		t.Fatalf("native file chooser returned %q: %v", path, err)
	}
}
