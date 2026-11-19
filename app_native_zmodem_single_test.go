package main

import (
	"testing"

	"github.com/hctty27/openshell/internal/domain"
)

func TestNativeZmodemSingleTransferRejectsUnsafePaths(t *testing.T) {
	var app App
	ref := domain.ConnectionRef{}
	for _, remote := range []string{"", "a\nb", "a\rb"} {
		if err := app.StartNativeZmodemInteractiveTransfer(ref, "download", "C:/Downloads", remote); err == nil {
			t.Fatalf("accepted unsupported remote path %q", remote)
		}
	}
	if err := app.StartNativeZmodemInteractiveTransfer(ref, "upload", "a\nb", ""); err == nil {
		t.Fatal("accepted multi-line local path")
	}
	if err := app.StartNativeZmodemInteractiveTransfer(ref, "upload", "", ""); err == nil {
		t.Fatal("accepted empty local file path")
	}
	if err := app.StartNativeZmodemInteractiveTransfer(ref, "invalid", "source", ""); err == nil {
		t.Fatal("accepted unsupported transfer direction")
	}
}
