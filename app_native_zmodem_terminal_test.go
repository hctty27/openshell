package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/hctty27/openshell/internal/domain"
)

func TestNativeZmodemInteractiveDesktopDisabledByDefault(t *testing.T) {
	t.Setenv("OPENSHELL_NATIVE_ZMODEM_EXPERIMENT", "")
	a, err := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	if err != nil { t.Fatal(err) }
	defer a.shutdown(context.Background())

	if a.NativeZmodemExperimentEnabled() { t.Fatal("native experiment unexpectedly enabled") }
	ref := domain.ConnectionRef{TabID: "tab", SessionID: "test", Generation: 1}
	status := a.NativeZmodemInteractiveReadiness(ref)
	if status.Ready || status.Code != "disabled" {
		t.Fatalf("native PTY experiment enabled by default: %+v", status)
	}
	if err := a.StartNativeZmodemInteractiveTransfer(ref, "upload", "source", ""); err == nil {
		t.Fatal("disabled native PTY experiment accepted a transfer")
	}
	if err := a.CancelNativeZmodemInteractiveTransfer(ref); err == nil {
		t.Fatal("disabled native PTY experiment allowed cancellation")
	}
	if _, err := a.NativeZmodemChooseUploadFile(); err == nil {
		t.Fatal("disabled native PTY experiment exposed the local file chooser")
	}
}

func TestNativeZmodemInteractiveDesktopRequiresExactActiveTerminal(t *testing.T) {
	t.Setenv("OPENSHELL_NATIVE_ZMODEM_EXPERIMENT", "1")
	executable, err := filepath.Abs(os.Args[0])
	if err != nil { t.Fatal(err) }
	t.Setenv("OPENSHELL_NATIVE_ZMODEM_SIDECAR", executable)
	a, err := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	if err != nil { t.Fatal(err) }
	defer a.shutdown(context.Background())

	if !a.NativeZmodemExperimentEnabled() { t.Fatal("developer opt-in ignored") }
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
	if err != nil || path != fake { t.Fatalf("native file chooser returned %q: %v", path, err) }
}
