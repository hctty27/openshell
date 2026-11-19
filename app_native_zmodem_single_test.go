package main

import (
	"strings"
	"testing"

	"github.com/hctty27/openshell/internal/domain"
)

// Invalid requests must be rejected before readiness, SSH or sidecar work.
// This keeps older UI bindings from bypassing the one-file rule.
func TestNativeZmodemSingleFileBoundary(t *testing.T) {
	var app App
	ref := domain.ConnectionRef{}
	cases := []struct {
		name string
		direction string
		local []string
		remote []string
	}{
		{"multiple local files", "upload", []string{"a", "b"}, nil},
		{"multiple remote files", "download", []string{"save"}, []string{"a", "b"}},
		{"empty selection", "upload", nil, nil},
		{"multiple upload remote directories", "upload", []string{"one"}, []string{"/tmp", "/var"}},
		{"newline-joined download paths", "download", []string{"save"}, []string{"a\nb"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := app.StartNativeZmodemInteractiveBatchTransfer(ref, tc.direction, tc.local, tc.remote)
			if err == nil {
				t.Fatalf("batch entrypoint accepted unsupported %s", tc.name)
			}
		})
	}
}

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
	if err := app.SkipNativeZmodemPendingFile(ref, "old-batch", 1); err == nil ||
		!strings.Contains(err.Error(), "不支持") {
		t.Fatalf("old skip API still works: %v", err)
	}
}
