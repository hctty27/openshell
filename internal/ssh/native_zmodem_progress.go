package sshclient

import (
    "bytes"
    "context"
    "encoding/hex"
    "strconv"
    "sync"
    "unicode/utf8"
)

const nativeZmodemProgressPrefix = "OSZP\t"
const nativeZmodemFilePrefix = "OSZF\t"
const nativeZmodemProgressMaximum = 100 * uint64(nativeZmodemMaxFileSize)

type NativeZmodemFileProgress struct {
    Kind string
    Index int
    Name string
    Total *uint64
    Processed uint64
}

type nativeZmodemFileObserverKey struct{}

func WithNativeZmodemFileObserver(ctx context.Context, observer func(NativeZmodemFileProgress)) context.Context {
    if observer == nil { return ctx }
    return context.WithValue(ctx, nativeZmodemFileObserverKey{}, observer)
}

type nativeZmodemSkipControlKey struct{}

func WithNativeZmodemSkipControl(ctx context.Context, file string) context.Context {
    if file == "" { return ctx }
    return context.WithValue(ctx, nativeZmodemSkipControlKey{}, file)
}

func nativeZmodemSkipControl(ctx context.Context) string {
    if ctx == nil { return "" }
    file, _ := ctx.Value(nativeZmodemSkipControlKey{}).(string)
    return file
}

func nativeZmodemFileObserver(ctx context.Context) func(NativeZmodemFileProgress) {
    if ctx == nil { return nil }
    observer, _ := ctx.Value(nativeZmodemFileObserverKey{}).(func(NativeZmodemFileProgress))
    return observer
}

// nativeTerminalProgressLog consumes bounded, line-delimited diagnostics.
// Only the sidecar stderr stream is parsed; binary stdout stays untouched.
type nativeTerminalProgressLog struct {
    mu sync.Mutex
    pending []byte
    log *nativeZmodemLog
    onProgress func(uint64, uint64)
    onFile func(NativeZmodemFileProgress)
}

func (w *nativeTerminalProgressLog) Write(p []byte) (int, error) {
    w.mu.Lock()
    defer w.mu.Unlock()
    original := len(p)
    for len(p) > 0 {
        end := bytes.IndexByte(p, '\n')
        if end < 0 {
            w.pending = append(w.pending, p...)
            if len(w.pending) > 1024 {
                _, _ = w.log.Write(w.pending)
                w.pending = nil
            }
            break
        }
        w.pending = append(w.pending, p[:end]...)
        w.processLine(w.pending)
        w.pending = nil
        p = p[end+1:]
    }
    return original, nil
}

func (w *nativeTerminalProgressLog) processLine(line []byte) {
    if bytes.HasPrefix(line, []byte(nativeZmodemFilePrefix)) {
        w.processFileLine(line)
        return
    }
    if !bytes.HasPrefix(line, []byte(nativeZmodemProgressPrefix)) {
        _, _ = w.log.Write(append(append([]byte(nil), line...), '\n'))
        return
    }
    fields := bytes.Split(bytes.TrimSuffix(line, []byte{'\r'}), []byte{'\t'})
    if len(fields) != 3 { return }
    processed, err := strconv.ParseUint(string(fields[1]), 10, 64)
    if err != nil { return }
    total, err := strconv.ParseUint(string(fields[2]), 10, 64)
    if err != nil || processed > nativeZmodemProgressMaximum || total > nativeZmodemProgressMaximum ||
        (total != 0 && processed > total) { return }
    if w.onProgress != nil { w.onProgress(processed, total) }
}

func (w *nativeTerminalProgressLog) processFileLine(line []byte) {
    fields := bytes.Split(bytes.TrimSuffix(line, []byte{'\r'}), []byte{'\t'})
    if len(fields) < 4 || len(fields) > 5 { return }
    kind := string(fields[1])
    if kind != "start" && kind != "progress" && kind != "completed" && kind != "skipped" { return }
    index, err := strconv.Atoi(string(fields[2]))
    if err != nil || index < 0 || index >= 100 { return }
    event := NativeZmodemFileProgress{Kind: kind, Index: index}
    switch kind {
    case "start":
        if len(fields) != 5 { return }
        if string(fields[3]) != "-1" {
            size, sizeErr := strconv.ParseUint(string(fields[3]), 10, 64)
            if sizeErr != nil || size > uint64(nativeZmodemMaxFileSize) { return }
            event.Total = &size
        }
        decoded, decodeErr := hex.DecodeString(string(fields[4]))
        if decodeErr != nil || len(decoded) == 0 || len(decoded) > 255 || !utf8.Valid(decoded) { return }
        event.Name = string(decoded)
    case "progress", "completed", "skipped":
        if len(fields) != 4 { return }
        processed, parseErr := strconv.ParseUint(string(fields[3]), 10, 64)
        if parseErr != nil || processed > uint64(nativeZmodemMaxFileSize) { return }
        event.Processed = processed
    }
    if w.onFile != nil { w.onFile(event) }
}
