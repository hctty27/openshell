//go:build windows

package main

import (
    "io"
    "testing"
    "time"
)

func TestWindowsConPTYSurvivesRepeatedDisconnectAndReconnect(t *testing.T) {
    for i := 0; i < 3; i++ {
        pty, err := newLocalPTY("cmd", 80, 24)
        if err != nil {
            t.Fatalf("start Windows local terminal %d: %v", i, err)
        }
        drained := make(chan struct{})
        go func() {
            _, _ = io.Copy(io.Discard, pty)
            close(drained)
        }()
        session := &localTerminalSession{id: "local", pty: pty}
        for n := 0; n < 8; n++ {
            results := make(chan error, 1)
            go func() { results <- session.close() }()
            select {
            case err := <-results:
                if err != nil { t.Fatalf("closing ConPTY: %v", err) }
            case <-time.After(12 * time.Second):
                t.Fatal("ConPTY close blocked while output was being drained")
            }
        }
        select {
        case <-drained:
        case <-time.After(12 * time.Second):
            t.Fatal("ConPTY output reader remained blocked after closing")
        }
    }
}
