package main

import (
	"path/filepath"
	"testing"

	"github.com/hctty27/openshell/internal/branding"
)

func TestSharedWebviewUserDataPathIsReleaseIndependent(t *testing.T) {
	cacheRoot := filepath.Join("C:", "Users", "tester", "AppData", "Local")
	got := sharedWebviewUserDataPath(cacheRoot)
	want := filepath.Join(cacheRoot, branding.Name, "WebView2")
	if got != want {
		t.Fatalf("sharedWebviewUserDataPath() = %q, want %q", got, want)
	}
}
