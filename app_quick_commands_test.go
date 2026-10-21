package main

import (
    "context"
    "encoding/json"
    "path/filepath"
    "testing"
)

func TestQuickCommandPreferencesPersistAndValidate(t *testing.T) {
    path := filepath.Join(t.TempDir(), "state.db")
    a, err := newApp(path, &vault{m: map[string]string{}}, nil)
    if err != nil { t.Fatal(err) }

    command := QuickCommand{
        ID: "cmd-1", Name: "查看磁盘", Command: "df -h", Category: "系统运维",
        Scope: "global", Mode: "run", Confirm: false,
    }
    raw, _ := json.Marshal([]QuickCommand{command})
    if err := a.SavePreference("quickCommands", string(raw)); err != nil { t.Fatal(err) }
    if err := a.SavePreference("quickCommandLayout", "multi"); err != nil { t.Fatal(err) }
    a.shutdown(context.Background())

    b, err := newApp(path, &vault{m: map[string]string{}}, nil)
    if err != nil { t.Fatal(err) }
    defer b.shutdown(context.Background())
    state, err := b.State()
    if err != nil { t.Fatal(err) }
    if state.QuickCommandLayout != "multi" || len(state.QuickCommands) != 1 || state.QuickCommands[0] != command {
        t.Fatalf("quick command preferences were not restored: %+v", state)
    }
    if err := b.SavePreference("quickCommandLayout", "horizontal"); err == nil {
        t.Fatal("invalid layout accepted")
    }
    for _, invalid := range []string{
        "not json",
        `[{"id":"1","name":"test","command":"rm -rf /\nwhoami","scope":"global","mode":"run"}]`,
        `[{"id":"1","name":"test","command":"pwd","scope":"global","mode":"run"},{"id":"1","name":"second","command":"ls","scope":"global","mode":"run"}]`,
        `[{"id":"1","name":"test","command":"pwd","scope":"session","mode":"run"}]`,
    } {
        if err := b.SavePreference("quickCommands", invalid); err == nil {
            t.Fatalf("invalid commands accepted: %s", invalid)
        }
    }
}
