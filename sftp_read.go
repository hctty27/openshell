package main

import (
    "context"
    "errors"
    "time"

    "github.com/hctty27/openshell/internal/diagnostics"
    "github.com/hctty27/openshell/internal/domain"
    files "github.com/hctty27/openshell/internal/sftp"
)

// SFTPReadRemoteTextRequest keeps each editor read cancellable without closing
// the shared SSH connection or SFTP client used by directory browsing.
func (a *App) SFTPReadRemoteTextRequest(ref domain.ConnectionRef, name, requestID string) (files.RemoteDocument, error) {
    if requestID == "" || len(requestID) > 128 {
        return files.RemoteDocument{}, errors.New("无效的文件读取请求")
    }

    parent := a.ctx
    if parent == nil { parent = context.Background() }
    ctx, cancel := context.WithCancel(parent)

    a.sftpReadMu.Lock()
    if a.sftpReadCancels == nil { a.sftpReadCancels = make(map[string]context.CancelFunc) }
    if _, exists := a.sftpReadCancels[requestID]; exists {
        a.sftpReadMu.Unlock()
        cancel()
        return files.RemoteDocument{}, errors.New("文件读取请求正在执行")
    }
    if _, cancelled := a.sftpReadCancelled[requestID]; cancelled {
        delete(a.sftpReadCancelled, requestID)
        cancel()
    }
    a.sftpReadCancels[requestID] = cancel
    a.sftpReadMu.Unlock()

    defer func() {
        a.sftpReadMu.Lock()
        delete(a.sftpReadCancels, requestID)
        a.sftpReadMu.Unlock()
        cancel()
    }()

    var record func(string, time.Duration)
    if manager, err := currentDiagnostics(); err == nil {
        record = func(stage string, duration time.Duration) {
            status := "ok"
            if duration >= 500*time.Millisecond { status = "slow" }
            manager.Record(diagnostics.Event{
                Module: "sftp", Operation: "SFTPRead." + stage,
                Status: status, DurationMS: float64(duration) / float64(time.Millisecond), Count: 1,
            })
        }
    }
    return a.sftp.ReadRemoteTextContext(ctx, ref, name, record)
}

// SFTPCancelReadRemoteText is safe when cancellation reaches the backend before
// its matching read call. Expired tombstones are bounded and pruned on demand.
func (a *App) SFTPCancelReadRemoteText(requestID string) {
    if requestID == "" || len(requestID) > 128 { return }

    a.sftpReadMu.Lock()
    defer a.sftpReadMu.Unlock()
    if cancel := a.sftpReadCancels[requestID]; cancel != nil {
        cancel()
        return
    }

    now := time.Now()
    if a.sftpReadCancelled == nil { a.sftpReadCancelled = make(map[string]time.Time) }
    for key, at := range a.sftpReadCancelled {
        if now.Sub(at) > time.Minute { delete(a.sftpReadCancelled, key) }
    }
    if len(a.sftpReadCancelled) >= 128 {
        var oldestKey string
        var oldest time.Time
        for key, at := range a.sftpReadCancelled {
            if oldestKey == "" || at.Before(oldest) { oldestKey, oldest = key, at }
        }
        delete(a.sftpReadCancelled, oldestKey)
    }
    a.sftpReadCancelled[requestID] = now
}
