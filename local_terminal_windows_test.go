//go:build windows

package main

import (
    "sync"
    "testing"
)

func TestWindowsConPTYSurvivesRepeatedDisconnectAndReconnect(t *testing.T) {
    for i := 0; i < 3; i++ {
        pty, err := newLocalPTY("cmd", 80, 24)
        if err != nil {
            t.Fatalf("start Windows local terminal %d: %v", i, err)
        }
        session := &localTerminalSession{id: "local", pty: pty}
        var wg sync.WaitGroup
        for n := 0; n < 8; n++ {
            wg.Add(1)
            go func() {
                defer wg.Done()
                if err := session.close(); err != nil {
                    t.Errorf("closing ConPTY: %v", err)
                }
            }()
        }
        wg.Wait()
    }
}
