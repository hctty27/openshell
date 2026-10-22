package main

import "testing"

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
