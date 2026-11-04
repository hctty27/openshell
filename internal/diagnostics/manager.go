package diagnostics

import (
    "archive/zip"
    "crypto/rand"
    "encoding/hex"
    "encoding/json"
    "errors"
    "fmt"
    "io"
    "os"
    "path/filepath"
    "runtime"
    "sort"
    "strings"
    "sync"
    "sync/atomic"
    "time"
)

const (
    maxLogBytes int64 = 5 << 20
    logBackups = 9
    recentLimit = 100
    maxOperations = 128
)

type Event struct {
    Time time.Time `json:"time"`
    Level string `json:"level"`
    Module string `json:"module"`
    Operation string `json:"operation"`
    Status string `json:"status"`
    Code string `json:"code,omitempty"`
    DurationMS float64 `json:"durationMs,omitempty"`
    Count int `json:"count,omitempty"`
}

type OperationStat struct {
    Module string `json:"module"`
    Operation string `json:"operation"`
    Count uint64 `json:"count"`
    P50MS float64 `json:"p50Ms"`
    P95MS float64 `json:"p95Ms"`
    MaxMS float64 `json:"maxMs"`
}

type Snapshot struct {
    StartedAt time.Time `json:"startedAt"`
    HeapBytes uint64 `json:"heapBytes"`
    Goroutines int `json:"goroutines"`
    Recorded uint64 `json:"recorded"`
    Dropped uint64 `json:"dropped"`
    DiskEnabled bool `json:"diskEnabled"`
    Events []Event `json:"events"`
    Operations []OperationStat `json:"operations"`
}

type operationSamples struct {
    module string
    operation string
    count uint64
    durations []float64
}

type queueItem struct {
    event *Event
    done chan struct{}
}

type Manager struct {
    mu sync.Mutex
    dir string
    file *os.File
    bytes int64
    startedAt time.Time
    lastPrune time.Time
    events []Event
    operations map[string]*operationSamples
    recorded uint64
    dropped atomic.Uint64
    stopped atomic.Bool
    queue chan queueItem
    stop chan struct{}
    finished chan struct{}
    closeOnce sync.Once
}

func Open(dir string) (*Manager, error) {
    if err := os.MkdirAll(dir, 0700); err != nil { return nil, err }
    path := filepath.Join(dir, "app.jsonl")
    file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
    if err != nil { return nil, err }
    stat, err := file.Stat()
    if err != nil { file.Close(); return nil, err }
    m := &Manager{
        dir: dir, file: file, bytes: stat.Size(), startedAt: time.Now(),
        operations: make(map[string]*operationSamples), queue: make(chan queueItem, 512),
        stop: make(chan struct{}), finished: make(chan struct{}),
    }
    m.prune()
    go m.run()
    return m, nil
}

func safeIdentifier(value string) string {
    if len(value) > 64 { value = value[:64] }
    var b strings.Builder
    for _, r := range value {
        if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' ||
            r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.' {
            b.WriteRune(r)
        }
    }
    if b.Len() == 0 { return "unknown" }
    return b.String()
}

func normalize(input Event) Event {
    result := Event{
        Time: time.Now(), Module: safeIdentifier(input.Module),
        Operation: safeIdentifier(input.Operation), Code: safeIdentifier(input.Code),
        Status: input.Status, Count: input.Count, DurationMS: input.DurationMS,
    }
    if input.Code == "" { result.Code = "" }
    if result.Status != "ok" && result.Status != "slow" && result.Status != "error" {
        result.Status = "ok"
    }
    if result.Count < 0 { result.Count = 0 }
    if result.Count > 1000000 { result.Count = 1000000 }
    if result.DurationMS < 0 || result.DurationMS > 600000 { result.DurationMS = 0 }
    switch result.Status {
    case "error": result.Level = "ERROR"
    case "slow": result.Level = "WARN"
    default: result.Level = "INFO"
    }
    return result
}

func (m *Manager) Record(input Event) {
    if m == nil || m.stopped.Load() { return }
    event := normalize(input)
    select {
    case m.queue <- queueItem{event: &event}:
    default: m.dropped.Add(1)
    }
}

func (m *Manager) RecordBatch(events []Event) {
    if len(events) > 100 { events = events[:100] }
    for _, event := range events { m.Record(event) }
}

func (m *Manager) run() {
    defer close(m.finished)
    for {
        select {
        case item := <-m.queue: m.handle(item)
        case <-m.stop:
            for {
                select {
                case item := <-m.queue: m.handle(item)
                default:
                    m.mu.Lock()
                    if m.file != nil { _ = m.file.Sync(); _ = m.file.Close(); m.file = nil }
                    m.mu.Unlock()
                    return
                }
            }
        }
    }
}

func (m *Manager) handle(item queueItem) {
    if item.done != nil {
        m.mu.Lock()
        if m.file != nil { _ = m.file.Sync() }
        m.mu.Unlock()
        close(item.done)
        return
    }
    event := *item.event
    m.mu.Lock()
    defer m.mu.Unlock()
    m.recorded++
    if len(m.events) >= recentLimit { copy(m.events, m.events[1:]); m.events = m.events[:recentLimit-1] }
    m.events = append(m.events, event)
    key := event.Module + "/" + event.Operation
    sample := m.operations[key]
    if sample == nil && len(m.operations) < maxOperations {
        sample = &operationSamples{module: event.Module, operation: event.Operation}
        m.operations[key] = sample
    }
    if sample != nil {
        sample.count++
        if len(sample.durations) >= 128 {
            copy(sample.durations, sample.durations[1:])
            sample.durations = sample.durations[:127]
        }
        sample.durations = append(sample.durations, event.DurationMS)
    }
    if m.file != nil {
        line, err := json.Marshal(event)
        if err != nil { m.dropped.Add(1); return }
        if m.bytes+int64(len(line)+1) > maxLogBytes { m.rotate() }
        if m.file != nil {
            n, err := m.file.Write(append(line, '\n'))
            m.bytes += int64(n)
            if err != nil { m.dropped.Add(1) }
        }
        if time.Since(m.lastPrune) > time.Hour { m.prune() }
    }
}

func (m *Manager) rotate() {
    if m.file != nil { _ = m.file.Close(); m.file = nil }
    for index := logBackups; index >= 1; index-- {
        old := filepath.Join(m.dir, fmt.Sprintf("app.%d.jsonl", index))
        if index == logBackups { _ = os.Remove(old) }
        if index > 1 {
            _ = os.Rename(filepath.Join(m.dir, fmt.Sprintf("app.%d.jsonl", index-1)), old)
        }
    }
    _ = os.Rename(filepath.Join(m.dir, "app.jsonl"), filepath.Join(m.dir, "app.1.jsonl"))
    file, err := os.OpenFile(filepath.Join(m.dir, "app.jsonl"), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
    if err == nil { m.file = file; m.bytes = 0 } else { m.dropped.Add(1) }
}

func (m *Manager) prune() {
    m.lastPrune = time.Now()
    cutoff := time.Now().Add(-7 * 24 * time.Hour)
    for i := 1; i <= logBackups; i++ {
        path := filepath.Join(m.dir, fmt.Sprintf("app.%d.jsonl", i))
        if info, err := os.Stat(path); err == nil && info.ModTime().Before(cutoff) {
            _ = os.Remove(path)
        }
    }
}

func percentile(values []float64, p float64) float64 {
    if len(values) == 0 { return 0 }
    index := int(float64(len(values)-1)*p + 0.5)
    return values[index]
}

func (m *Manager) Snapshot() Snapshot {
    var memory runtime.MemStats
    runtime.ReadMemStats(&memory)
    result := Snapshot{HeapBytes: memory.HeapAlloc, Goroutines: runtime.NumGoroutine()}
    if m == nil { return result }
    m.mu.Lock()
    result.StartedAt = m.startedAt
    result.Recorded = m.recorded
    result.DiskEnabled = m.file != nil
    result.Events = append([]Event{}, m.events...)
    for _, operation := range m.operations {
        samples := append([]float64{}, operation.durations...)
        sort.Float64s(samples)
        var max float64
        if len(samples) > 0 { max = samples[len(samples)-1] }
        result.Operations = append(result.Operations, OperationStat{
            Module: operation.module, Operation: operation.operation,
            Count: operation.count, P50MS: percentile(samples, 0.50),
            P95MS: percentile(samples, 0.95), MaxMS: max,
        })
    }
    m.mu.Unlock()
    result.Dropped = m.dropped.Load()
    sort.Slice(result.Operations, func(i, j int) bool {
        return result.Operations[i].P95MS > result.Operations[j].P95MS
    })
    return result
}

func (m *Manager) flush() {
    if m == nil || m.stopped.Load() { return }
    done := make(chan struct{})
    select {
    case m.queue <- queueItem{done: done}:
        select { case <-done: case <-m.finished: }
    case <-m.finished:
    }
}

func (m *Manager) Export() (string, error) {
    if m == nil { return "", errors.New("diagnostics unavailable") }
    m.flush()
    reportDir := filepath.Join(m.dir, "reports")
    if err := os.MkdirAll(reportDir, 0700); err != nil { return "", err }
    nonce := make([]byte, 4)
    if _, err := rand.Read(nonce); err != nil { return "", err }
    filename := "openshell-diagnostics-" + time.Now().Format("20060102-150405") + "-" + hex.EncodeToString(nonce) + ".zip"
    path := filepath.Join(reportDir, filename)
    output, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
    if err != nil { return "", err }
    archive := zip.NewWriter(output)
    writeJSON := func(name string, value any) error {
        target, err := archive.Create(name)
        if err != nil { return err }
        return json.NewEncoder(target).Encode(value)
    }
    if err = writeJSON("manifest.json", map[string]any{"schema": 1, "generatedAt": time.Now(), "privacy": "no terminal contents, hostnames, secrets or file paths"}); err == nil {
        err = writeJSON("summary.json", m.Snapshot())
    }
    if err == nil {
        for i := logBackups; i >= 0; i-- {
            name := "app.jsonl"
            if i != 0 { name = fmt.Sprintf("app.%d.jsonl", i) }
            input, openErr := os.Open(filepath.Join(m.dir, name))
            if os.IsNotExist(openErr) { continue }
            if openErr != nil { err = openErr; break }
            target, createErr := archive.Create("logs/" + name)
            if createErr == nil { _, createErr = io.Copy(target, input) }
            _ = input.Close()
            if createErr != nil { err = createErr; break }
        }
    }
    if closeErr := archive.Close(); err == nil { err = closeErr }
    if closeErr := output.Close(); err == nil { err = closeErr }
    if err != nil { _ = os.Remove(path); return "", err }
    return path, nil
}

func (m *Manager) Close() {
    if m == nil { return }
    m.closeOnce.Do(func() {
        m.stopped.Store(true)
        close(m.stop)
        <-m.finished
    })
}
