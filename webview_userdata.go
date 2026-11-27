package main

import (
	"path/filepath"

	"github.com/hctty27/openshell/internal/branding"
)

// sharedWebviewUserDataPath returns a release-independent WebView2 profile path.
// The executable name intentionally does not participate in this path, so
// versioned portable builds and the installed build reuse the same profile.
func sharedWebviewUserDataPath(cacheRoot string) string {
	return filepath.Join(cacheRoot, branding.Name, "WebView2")
}
