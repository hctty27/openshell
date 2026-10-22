package main

import (
    "io"
    "sync"
    "sync/atomic"
    "testing"

    "github.com/hctty27/openshell/internal/domain"
)

func TestStartLocalTerminalRejectsInvalidArguments(t *testing.T) {
    app := &App{}
    cases := []struct {
        name, tabID, sessionID string
        cols, rows int
    }{
        {"empty tab", "", "local-1", 80, 24},
        {"empty session", "tab-1", "", 80, 24},
        {"zero columns", "tab-1", "local-1", 0, 24},
        {"zero rows", "tab-1", "local-1", 80, 0},
        {"oversized terminal", "tab-1", "local-1", 2000, 24},
    }
    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) {
            if err := app.StartLocalTerminal(tc.tabID, tc.sessionID, "powershell", tc.cols, tc.rows); err == nil {
                t.Fatal("expected invalid arguments to be rejected")
            }
        })
    }
}

func TestLocalTerminalStaleSessionCannotReceiveInput(t *testing.T) {
    app := &App{localTerminals: map[string]*localTerminalSession{}}
    if err := app.WriteLocalTerminal("tab-1", "expired", "ZWNobyBoaQ=="); err == nil {
        t.Fatal("stale terminal accepted input")
    }
    if err := app.ResizeLocalTerminal("tab-1", "expired", 80, 24); err == nil {
        t.Fatal("stale terminal accepted resize")
    }
}

type blockingLocalPTY struct {
    closed chan struct{}
    once sync.Once
}
func (p *blockingLocalPTY) Read(_ []byte) (int, error) {
    <-p.closed
    return 0, io.EOF
}
func (p *blockingLocalPTY) Write(data []byte) (int, error) { return len(data), nil }
func (p *blockingLocalPTY) Resize(_, _ int) error { return nil }
func (p *blockingLocalPTY) Close() error {
    p.once.Do(func() { close(p.closed) })
    return nil
}

func newLocalRaceTestApp() (*App, chan struct{}, chan struct{}, *blockingLocalPTY) {
    started := make(chan struct{})
    release := make(chan struct{})
    pty := &blockingLocalPTY{closed: make(chan struct{})}
    a := &App{
        tabRefs: map[string]domain.ConnectionRef{
            "tab-1": {TabID: "tab-1", SessionID: "ssh-1", Generation: 1},
        },
        connectEpoch: map[string]uint64{"tab-1": 1},
        localTerminals: map[string]*localTerminalSession{},
        localTerminalPending: map[string]string{},
        emit: func(string, any) {},
    }
    a.localTerminalFactory = func(_ string, _, _ int) (localPTY, error) {
        close(started)
        <-release
        return pty, nil
    }
    return a, started, release, pty
}

func TestLocalPTYLaunchIgnoresDisconnectEpochChange(t *testing.T) {
    a, started, release, _ := newLocalRaceTestApp()
    done := make(chan error, 1)
    go func() { done <- a.StartLocalTerminal("tab-1", "local-1", "powershell", 80, 24) }()
    <-started
    a.mu.Lock()
    a.connectEpoch["tab-1"]++ // A delayed SSH Disconnect must not cancel the local PTY.
    a.mu.Unlock()
    close(release)
    if err := <-done; err != nil { t.Fatalf("local PTY rejected disconnect: %v", err) }
    a.CloseLocalTerminal("tab-1", "local-1")
}

func TestCancelledPendingLocalPTYCannotResurrectAfterClose(t *testing.T) {
    a, started, release, pty := newLocalRaceTestApp()
    done := make(chan error, 1)
    go func() { done <- a.StartLocalTerminal("tab-1", "local-1", "powershell", 80, 24) }()
    <-started
    a.CloseLocalTerminal("tab-1", "local-1")
    close(release)
    if err := <-done; err == nil { t.Fatal("cancelled local PTY was adopted") }
    select {
    case <-pty.closed:
    default:
        t.Fatal("cancelled local PTY was not closed")
    }
}

func TestPendingLocalPTYCannotAttachToReconnectedSSH(t *testing.T) {
    a, started, release, pty := newLocalRaceTestApp()
    done := make(chan error, 1)
    go func() { done <- a.StartLocalTerminal("tab-1", "local-1", "powershell", 80, 24) }()
    <-started
    a.mu.Lock()
    a.tabRefs["tab-1"] = domain.ConnectionRef{TabID: "tab-1", SessionID: "ssh-1", Generation: 2}
    a.mu.Unlock()
    close(release)
    if err := <-done; err == nil { t.Fatal("stale local PTY attached to reconnected SSH") }
    select {
    case <-pty.closed:
    default:
        t.Fatal("stale local PTY was not closed")
    }
}

type countingLocalPTY struct {
    closes atomic.Int32
}

func (p *countingLocalPTY) Read(_ []byte) (int, error) { return 0, io.EOF }
func (p *countingLocalPTY) Write(data []byte) (int, error) { return len(data), nil }
func (p *countingLocalPTY) Resize(_, _ int) error { return nil }
func (p *countingLocalPTY) Close() error {
    p.closes.Add(1)
    return nil
}

func TestLocalTerminalCloseOnceAcrossConcurrentTeardown(t *testing.T) {
    pty := &countingLocalPTY{}
    session := &localTerminalSession{id: "local-1", pty: pty}
    app := &App{localTerminals: map[string]*localTerminalSession{"tab-1": session}}
    var wg sync.WaitGroup
    for i := 0; i < 32; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            if err := session.close(); err != nil { t.Errorf("close: %v", err) }
            app.stopLocalTerminal("tab-1", "local-1")
        }()
    }
    wg.Wait()
    app.closeAllLocalTerminals()
    if got := pty.closes.Load(); got != 1 {
        t.Fatalf("ConPTY Close called %d times, want exactly once", got)
    }
}
