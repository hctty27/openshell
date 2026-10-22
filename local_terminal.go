package main

import (
    "encoding/base64"
    "errors"
    "fmt"
    "io"
    "sync"
)

type localPTY interface {
    io.ReadWriteCloser
    Resize(int, int) error
}
type localTerminalSession struct {
    id string
    pty localPTY
    closeOnce sync.Once
    closeErr error
}

func (s *localTerminalSession) close() error {
    s.closeOnce.Do(func() {
        s.closeErr = s.pty.Close()
    })
    return s.closeErr
}
type localOutputEvent struct {
    TabID string `json:"tabId"`
    TerminalID string `json:"terminalId"`
    Data string `json:"data"`
}
type localEndEvent struct {
    TabID string `json:"tabId"`
    TerminalID string `json:"terminalId"`
}
func (a *App) StartLocalTerminal(tabID, terminalID, shell string, cols, rows int) error {
    if len(tabID) == 0 || len(tabID) > 128 || len(terminalID) == 0 || len(terminalID) > 256 {
        return errors.New("invalid local terminal identifier")
    }
    if cols < 1 || cols > 1000 || rows < 1 || rows > 1000 {
        return errors.New("invalid local terminal dimensions")
    }
    a.mu.Lock()
    ref, exists := a.tabRefs[tabID]
    if !exists {
        a.mu.Unlock()
        return errors.New("terminal tab no longer exists")
    }
    if a.localTerminalPending == nil {
        a.localTerminalPending = make(map[string]string)
    }
    a.localTerminalPending[tabID] = terminalID
    factory := a.localTerminalFactory
    a.mu.Unlock()
    if a.ssh != nil && a.ssh.Valid(ref) {
        a.stopPendingLocalTerminal(tabID, terminalID)
        return errors.New("SSH must disconnect before starting the local terminal")
    }
    if factory == nil {
        factory = newLocalPTY
    }
    pty, err := factory(shell, cols, rows)
    if err != nil {
        a.stopPendingLocalTerminal(tabID, terminalID)
        return fmt.Errorf("start local shell: %w", err)
    }
    current := &localTerminalSession{id: terminalID, pty: pty}
    a.mu.Lock()
    latestRef, valid := a.tabRefs[tabID]
    if !valid || latestRef != ref || a.localTerminalPending[tabID] != terminalID {
        a.mu.Unlock()
        _ = current.close()
        return errors.New("terminal connection changed")
    }
    delete(a.localTerminalPending, tabID)
    old := a.localTerminals[tabID]
    a.localTerminals[tabID] = current
    a.mu.Unlock()
    if old != nil { _ = old.close() }
    go func() {
        defer func() {
            a.mu.Lock()
            if a.localTerminals[tabID] == current { delete(a.localTerminals, tabID) }
            a.mu.Unlock()
            _ = current.close()
            a.emit("local:ended", localEndEvent{TabID:tabID, TerminalID:terminalID})
        }()
        buf := make([]byte, 32*1024)
        for {
            n, readErr := pty.Read(buf)
            if n > 0 {
                a.emit("local:output", localOutputEvent{
                    TabID:tabID, TerminalID:terminalID,
                    Data:base64.StdEncoding.EncodeToString(buf[:n]),
                })
            }
            if readErr != nil { return }
        }
    }()
    return nil
}
func (a *App) WriteLocalTerminal(tabID, terminalID, data string) error {
    if len(data) > 1024*1024 { return errors.New("local terminal input too large") }
    decoded, err := base64.StdEncoding.DecodeString(data)
    if err != nil { return err }
    a.mu.Lock()
    session := a.localTerminals[tabID]
    a.mu.Unlock()
    if session == nil || session.id != terminalID { return io.ErrClosedPipe }
    _, err = session.pty.Write(decoded)
    return err
}
func (a *App) ResizeLocalTerminal(tabID, terminalID string, cols, rows int) error {
    if cols < 1 || cols > 1000 || rows < 1 || rows > 1000 { return errors.New("invalid terminal dimensions") }
    a.mu.Lock()
    session := a.localTerminals[tabID]
    a.mu.Unlock()
    if session == nil || session.id != terminalID { return io.ErrClosedPipe }
    return session.pty.Resize(cols, rows)
}
func (a *App) CloseLocalTerminal(tabID, terminalID string) error {
    a.stopLocalTerminal(tabID, terminalID)
    return nil
}
func (a *App) stopPendingLocalTerminal(tabID, terminalID string) {
    a.mu.Lock()
    if a.localTerminalPending[tabID] == terminalID {
        delete(a.localTerminalPending, tabID)
    }
    a.mu.Unlock()
}

func (a *App) stopLocalTerminal(tabID, terminalID string) {
    a.mu.Lock()
    if terminalID == "" || a.localTerminalPending[tabID] == terminalID {
        delete(a.localTerminalPending, tabID)
    }
    session := a.localTerminals[tabID]
    if session != nil && (terminalID == "" || session.id == terminalID) {
        delete(a.localTerminals, tabID)
    } else { session = nil }
    a.mu.Unlock()
    if session != nil { _ = session.close() }
}
func (a *App) closeAllLocalTerminals() {
    a.mu.Lock()
    sessions := make([]*localTerminalSession, 0, len(a.localTerminals))
    for _, session := range a.localTerminals { sessions = append(sessions, session) }
    a.localTerminals = map[string]*localTerminalSession{}
    a.localTerminalPending = map[string]string{}
    a.mu.Unlock()
    for _, session := range sessions { _ = session.close() }
}
