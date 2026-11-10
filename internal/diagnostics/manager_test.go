package diagnostics

import (
    "archive/zip"
    "encoding/json"
    "os"
    "runtime"
    "path/filepath"
    "strings"
    "testing"
    "time"
)

func TestNormalizeRejectsFreeformIdentifiers(t *testing.T) {
    input := Event{
        Module: "ssh /root/.ssh/id_rsa",
        Operation: "Connect?token=sk-secret",
        Status: "error", Code: "bad\nsecret", DurationMS: -12,
    }
    event := normalize(input)
    if strings.ContainsAny(event.Module+event.Operation+event.Code, " /?=\n") {
        t.Fatalf("unsafe identifier: %#v", event)
    }
    if event.Module != "unknown" || event.Operation != "unknown" || event.Code != "other" { t.Fatalf("freeform data was retained: %#v", event) }
    if event.Level != "ERROR" || event.DurationMS != 0 {
        t.Fatalf("unexpected normalization: %#v", event)
    }
}

func TestRecordsAndExportsOnlyCategoricalData(t *testing.T) {
    dir := t.TempDir()
    manager, err := Open(dir)
    if err != nil { t.Fatal(err) }
    defer manager.Close()
    manager.RecordBatch([]Event{
        {Module: "ssh", Operation: "Connect", Status: "ok", DurationMS: 23},
        {Module: "sftp", Operation: "SFTPList", Status: "slow", DurationMS: 1200},
        {Module: "frontend", Operation: "uncaught_error", Status: "error", Code: "uncaught_error"},
    })
    manager.flush()
    snap := manager.Snapshot()
    if snap.Recorded != 3 || len(snap.Events) != 3 {
        t.Fatalf("snapshot: %#v", snap)
    }
    if !snap.DiskEnabled || len(snap.Operations) != 3 { t.Fatalf("missing stats: %#v", snap) }
    path, err := manager.Export()
    if err != nil { t.Fatal(err) }
    if !strings.HasPrefix(path, filepath.Join(dir, "reports")) { t.Fatalf("unsafe output path: %s", path) }
    info, err := os.Stat(path)
    if err != nil { t.Fatal(err) }
    // Windows FileMode reports synthetic 0666 permission bits; ACLs are inherited
    // from the containing user directory and cannot be validated with ModePerm.
    if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
        t.Fatalf("export permissions: %v", info.Mode())
    }
    archive, err := zip.OpenReader(path)
    if err != nil { t.Fatal(err) }
    defer archive.Close()
    found := make(map[string]bool)
    for _, file := range archive.File {
        found[file.Name] = true
        if file.Name == "summary.json" {
            reader, err := file.Open()
            if err != nil { t.Fatal(err) }
            var summary Snapshot
            err = json.NewDecoder(reader).Decode(&summary)
            _ = reader.Close()
            if err != nil || summary.Recorded != 3 { t.Fatalf("summary: %#v, %v", summary, err) }
        }
    }
    if !found["manifest.json"] || !found["summary.json"] || !found["logs/app.jsonl"] {
        t.Fatalf("unexpected archive files: %#v", found)
    }
}

func TestRotatesLogsWithoutOversizedHistory(t *testing.T) {
    dir := t.TempDir()
    if err := os.WriteFile(filepath.Join(dir, "app.jsonl"), make([]byte, maxLogBytes-10), 0600); err != nil {
        t.Fatal(err)
    }
    manager, err := Open(dir)
    if err != nil { t.Fatal(err) }
    manager.Record(Event{Module: "ssh", Operation: "Connect", Status: "ok"})
    manager.flush()
    manager.Close()
    if _, err := os.Stat(filepath.Join(dir, "app.1.jsonl")); err != nil { t.Fatal(err) }
    info, err := os.Stat(filepath.Join(dir, "app.jsonl"))
    if err != nil { t.Fatal(err) }
    if info.Size() <= 0 || info.Size() > maxLogBytes { t.Fatalf("rotated size: %d", info.Size()) }
}

func TestConcurrentCloseAndRecord(t *testing.T) {
    manager, err := Open(t.TempDir())
    if err != nil { t.Fatal(err) }
    done := make(chan struct{})
    go func() {
        defer close(done)
        for i := 0; i < 1000; i++ {
            manager.Record(Event{Module: "terminal", Operation: "xterm_write_batch", Status: "ok"})
        }
    }()
    manager.Close()
    select {
    case <-done:
    case <-time.After(2 * time.Second): t.Fatal("record blocked on shutdown")
    }
    manager.Close()
}

func TestReportRetention(t *testing.T) {
    manager, err := Open(t.TempDir())
    if err != nil { t.Fatal(err) }
    defer manager.Close()
    var lastExport string
    for i := 0; i < 5; i++ {
        lastExport, err = manager.Export()
        if err != nil { t.Fatal(err) }
    }
    // On Windows multiple exports may have identical modification times.
    // A retention cleanup must never delete the freshly exported path.
    if _, err := os.Stat(lastExport); err != nil { t.Fatalf("newest report was pruned: %v", err) }
    reports, err := os.ReadDir(filepath.Join(manager.dir, "reports"))
    if err != nil { t.Fatal(err) }
    if len(reports) != 3 { t.Fatalf("expected three retained diagnostic reports, got %d", len(reports)) }
}

func TestPruneExpiredReportsAtOpen(t *testing.T) {
    dir := t.TempDir()
    reportDir := filepath.Join(dir, "reports")
    if err := os.MkdirAll(reportDir, 0700); err != nil { t.Fatal(err) }
    filename := filepath.Join(reportDir, "openshell-diagnostics-expired.zip")
    if err := os.WriteFile(filename, []byte("expired"), 0600); err != nil { t.Fatal(err) }
    old := time.Now().Add(-8 * 24 * time.Hour)
    if err := os.Chtimes(filename, old, old); err != nil { t.Fatal(err) }
    manager, err := Open(dir)
    if err != nil { t.Fatal(err) }
    defer manager.Close()
    if _, err := os.Stat(filename); !os.IsNotExist(err) {
        t.Fatalf("expired report was retained: %v", err)
    }
}


func TestIMEDiagnosticsKeepOnlySafeGeometry(t *testing.T) {
    event := normalize(Event{
        Module: "ime", Operation: "window_active", Status: "ok",
        IME: &IMEGeometry{
            Target: "textarea/password", HasFocus: true, RectX: 123.456,
            RectY: 12.345, RectWidth: 245, RectHeight: 28, DPR: 2,
            ScreenX: 700, ScreenY: 200,
        },
    })
    if event.Module != "ime" || event.IME == nil || event.IME.Target != "other" {
        t.Fatalf("IME geometry not sanitized: %#v", event)
    }
    if event.IME.RectX != 123.46 || event.IME.RectY != 12.35 || !event.IME.HasFocus {
        t.Fatalf("unexpected IME geometry: %#v", event.IME)
    }

    unrelated := normalize(Event{
        Module: "ssh", Operation: "Connect", Status: "ok",
        IME: &IMEGeometry{Target: "input", ScreenX: 100},
    })
    if unrelated.IME != nil { t.Fatalf("unrelated event persisted IME data: %#v", unrelated) }

    invalid := normalize(Event{
        Module: "ime", Operation: "composition_start", Status: "ok",
        IME: &IMEGeometry{Target: "input", RectX: 9999999, DPR: 99999},
    })
    if invalid.IME == nil || invalid.IME.RectX != 0 || invalid.IME.DPR != 0 {
        t.Fatalf("out-of-bounds geometry persisted: %#v", invalid.IME)
    }
}
