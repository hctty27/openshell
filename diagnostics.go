package main

import (
    "os"
    "path/filepath"
    "sync"

    "github.com/hctty27/openshell/internal/branding"
    "github.com/hctty27/openshell/internal/diagnostics"
)

var (
    diagnosticOnce sync.Once
    diagnosticManager *diagnostics.Manager
    diagnosticError error
)

func currentDiagnostics() (*diagnostics.Manager, error) {
    diagnosticOnce.Do(func() {
        dir, err := os.UserCacheDir()
        if err != nil {
            diagnosticError = err
            return
        }
        diagnosticManager, diagnosticError = diagnostics.Open(filepath.Join(dir, branding.Name, "diagnostics"))
    })
    return diagnosticManager, diagnosticError
}

// DiagnosticsRecordBatch accepts only categorical metadata, never terminal contents.
func (a *App) DiagnosticsRecordBatch(events []diagnostics.Event) {
    manager, err := currentDiagnostics()
    if err == nil { manager.RecordBatch(events) }
}

func (a *App) DiagnosticsSnapshot() (diagnostics.Snapshot, error) {
    manager, err := currentDiagnostics()
    if err != nil { return diagnostics.Snapshot{}, err }
    return manager.Snapshot(), nil
}

func (a *App) DiagnosticsExport() (string, error) {
    manager, err := currentDiagnostics()
    if err != nil { return "", err }
    return manager.Export()
}

func closeDiagnostics() {
    if diagnosticManager != nil { diagnosticManager.Close() }
}
