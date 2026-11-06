package main

import (
    "os"
    "path/filepath"
    "strings"
    "testing"

    "github.com/hctty27/openshell/internal/domain"
)

func TestNativeZmodemSkipOnlyAllowsPendingFiles(t *testing.T) {
    ref := domain.ConnectionRef{TabID: "tab-skip", SessionID: "server", Generation: 1}
    controlPath := filepath.Join(t.TempDir(), "skip")
    if err := os.WriteFile(controlPath, nil, 0600); err != nil { t.Fatal(err) }
    var emitted int
    app := &App{
        nativeZmodemSkips: map[domain.ConnectionRef]*nativeZmodemSkipControl{
            ref: {batchID: "batch", path: controlPath, activeIndex: 0,
                fileCount: 3, requested: make(map[int]bool)},
        },
        emit: func(name string, _ any) { if name == "ssh:native-zmodem-file" { emitted++ } },
    }
    if err := app.SkipNativeZmodemPendingFile(ref, "other-batch", 1); err == nil {
        t.Fatal("stale batch skip accepted")
    }
    if err := app.SkipNativeZmodemPendingFile(ref, "batch", 0); err == nil {
        t.Fatal("active file skip accepted")
    }
    if err := app.SkipNativeZmodemPendingFile(ref, "batch", 3); err == nil {
        t.Fatal("out of bounds skip accepted")
    }
    if err := app.SkipNativeZmodemPendingFile(ref, "batch", 2); err != nil { t.Fatal(err) }
    if err := app.SkipNativeZmodemPendingFile(ref, "batch", 2); err != nil { t.Fatal(err) }
    payload, err := os.ReadFile(controlPath)
    if err != nil { t.Fatal(err) }
    if strings.TrimSpace(string(payload)) != "2" || emitted != 1 {
        t.Fatalf("skip control should be idempotent: %q events %d", payload, emitted)
    }
}
