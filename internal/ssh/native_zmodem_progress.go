package sshclient

import (
    "bytes"
    "strconv"
    "sync"
)

const nativeZmodemProgressPrefix = "OSZP\t"
const nativeZmodemProgressMaximum = 128 * 1024 * 1024

// nativeTerminalProgressLog consumes bounded, line-delimited diagnostics.
// Only the sidecar stderr stream is parsed; binary stdout stays untouched.
type nativeTerminalProgressLog struct {
    mu sync.Mutex
    pending []byte
    log *nativeZmodemLog
    onProgress func(uint64, uint64)
}

func (w *nativeTerminalProgressLog) Write(p []byte) (int, error) {
    w.mu.Lock()
    defer w.mu.Unlock()
    original := len(p)
    for len(p) > 0 {
        end := bytes.IndexByte(p, '\n')
        if end < 0 {
            w.pending = append(w.pending, p...)
            if len(w.pending) > 512 {
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
