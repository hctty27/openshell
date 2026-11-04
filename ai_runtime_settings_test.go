package main

import (
    "context"
    "path/filepath"
    "testing"

    "github.com/hctty27/openshell/internal/store"
)

func TestAIRuntimeSettingsDefaultsAndPersistence(t *testing.T) {
    db, err := store.Open(filepath.Join(t.TempDir(), "state.db"))
    if err != nil { t.Fatal(err) }
    defer db.Close()
    app := &App{ctx: context.Background(), store: db}

    initial, err := app.AIRuntimeSettings()
    if err != nil { t.Fatal(err) }
    if !initial.AutoCompact || initial.CompactThreshold != 90 || initial.MaxSteps != 12 ||
        initial.TaskTimeoutMinutes != 10 || initial.KeepRecentTurns != 6 {
        t.Fatalf("unexpected defaults: %+v", initial)
    }

    updated := AIRuntimeSettings{
        AutoCompact: false, CompactThreshold: 85,
        MaxSteps: 30, TaskTimeoutMinutes: 20, KeepRecentTurns: 10,
    }
    if err := app.AISaveRuntimeSettings(updated); err != nil { t.Fatal(err) }
    restored, err := app.AIRuntimeSettings()
    if err != nil { t.Fatal(err) }
    if restored != updated { t.Fatalf("got %+v want %+v", restored, updated) }

    invalid := updated
    invalid.MaxSteps = 999
    if err := app.AISaveRuntimeSettings(invalid); err == nil { t.Fatal("invalid limit accepted") }
    unchanged, err := app.AIRuntimeSettings()
    if err != nil || unchanged != updated { t.Fatalf("invalid setting overwrote existing: %+v %v", unchanged, err) }
}

func TestAIConfigurableCompactionKeepsRecentTurns(t *testing.T) {
    messages := make([]store.AIMessage, 0, 20)
    for range 10 {
        messages = append(messages, store.AIMessage{Role: "user", Content: "question"})
        messages = append(messages, store.AIMessage{Role: "assistant", Content: "answer"})
    }
    c := store.AIConversation{Messages: messages}
    if got := aiCompactBoundary(c, len(messages), 6); got != 8 {
        t.Fatalf("expected six complete turns retained; cutoff=%d", got)
    }
    if got := aiCompactBoundary(c, len(messages), 10); got != 0 {
        t.Fatalf("expected all ten turns retained; cutoff=%d", got)
    }
    if got := aiCompactBoundary(c, len(messages), 2); got != 16 {
        t.Fatalf("expected two complete turns retained; cutoff=%d", got)
    }
    c.CompactedThrough = 16
    if got := aiCompactBoundary(c, len(messages), 6); got != 16 {
        t.Fatalf("should not compact an insufficient recent tail: %d", got)
    }
}

func TestAIRuntimeSettingsRejectInvalidConfig(t *testing.T) {
    examples := []AIRuntimeSettings{
        {AutoCompact: true, CompactThreshold: 70, MaxSteps: 12, TaskTimeoutMinutes: 10, KeepRecentTurns: 6},
        {AutoCompact: true, CompactThreshold: 90, MaxSteps: 0, TaskTimeoutMinutes: 10, KeepRecentTurns: 6},
        {AutoCompact: true, CompactThreshold: 90, MaxSteps: 12, TaskTimeoutMinutes: 120, KeepRecentTurns: 6},
        {AutoCompact: true, CompactThreshold: 90, MaxSteps: 12, TaskTimeoutMinutes: 10, KeepRecentTurns: 1},
    }
    for _, settings := range examples {
        if err := settings.validate(); err == nil { t.Fatalf("accepted invalid settings: %+v", settings) }
    }
}
