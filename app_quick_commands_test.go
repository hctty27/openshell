package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestQuickCommandPreferencesPersistAndValidate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	a, err := newApp(path, &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	legacy := QuickCommand{
		ID: "cmd-1", Name: "查看磁盘", Command: "df -h", Category: "系统运维",
		Scope: "global", Mode: "run", Confirm: false,
	}
	raw, _ := json.Marshal([]QuickCommand{legacy})
	if err := a.SavePreference("quickCommands", string(raw)); err != nil {
		t.Fatal(err)
	}
	if err := a.SavePreference("quickCommandLayout", "multi"); err != nil {
		t.Fatal(err)
	}
	a.shutdown(context.Background())

	b, err := newApp(path, &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer b.shutdown(context.Background())
	state, err := b.State()
	if err != nil {
		t.Fatal(err)
	}
	expected := legacy
	expected.Command += "\n"
	expected.Mode = ""
	if state.QuickCommandLayout != "multi" || len(state.QuickCommands) != 1 || state.QuickCommands[0] != expected {
		t.Fatalf("quick command preferences were not migrated: %+v", state)
	}
	if err := b.SavePreference("quickCommandLayout", "horizontal"); err == nil {
		t.Fatal("invalid layout accepted")
	}
	for _, invalid := range []string{
		"not json",
		`[{"id":"1","name":"test","command":"ls\u0000","scope":"global"}]`,
		`[{"id":"1","name":"test","command":"pwd","scope":"global"},{"id":"1","name":"second","command":"ls","scope":"global"}]`,
		`[{"id":"1","name":"test","command":"pwd","scope":"session"}]`,
	} {
		if err := b.SavePreference("quickCommands", invalid); err == nil {
			t.Fatalf("invalid commands accepted: %s", invalid)
		}
	}
	long, _ := json.Marshal([]QuickCommand{{ID: "long", Name: "test", Command: strings.Repeat("x", 16*1024+1), Scope: "global"}})
	if err := b.SavePreference("quickCommands", string(long)); err == nil {
		t.Fatal("oversized command accepted")
	}
}

func TestQuickCommandNewlinesAndLegacyModes(t *testing.T) {
	a, err := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.shutdown(context.Background())
	commands := []QuickCommand{
		{ID: "multi", Name: "multi", Command: "ps -ef | grep redis\r\nredis-cli -p 26379\n", Scope: "global"},
		{ID: "partial", Name: "partial", Command: "ls\npwd", Scope: "global"},
		{ID: "tabs", Name: "tabs", Command: "if true; then\n\techo ok\nfi\n", Scope: "global"},
	}
	raw, _ := json.Marshal(commands)
	if err := a.SavePreference("quickCommands", string(raw)); err != nil {
		t.Fatal(err)
	}
	state, err := a.State()
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range commands {
		if got := state.QuickCommands[i]; got != want {
			t.Fatalf("new command %d changed during roundtrip: %+v", i, got)
		}
	}
	legacy := []QuickCommand{
		{ID: "run", Name: "run", Command: "uptime", Scope: "global", Mode: "run"},
		{ID: "insert", Name: "insert", Command: "date", Scope: "global", Mode: "insert"},
	}
	raw, _ = json.Marshal(legacy)
	if err := a.SavePreference("quickCommands", string(raw)); err != nil {
		t.Fatal(err)
	}
	state, err = a.State()
	if err != nil {
		t.Fatal(err)
	}
	if state.QuickCommands[0].Command != "uptime\n" || state.QuickCommands[1].Command != "date" {
		t.Fatalf("legacy actions not preserved: %+v", state.QuickCommands)
	}
	for _, command := range state.QuickCommands {
		if command.Mode != "" {
			t.Fatalf("legacy mode not cleared: %+v", command)
		}
	}
	updated := state.QuickCommands
	updated[0].Command = "uptime"
	raw, _ = json.Marshal(updated)
	if err := a.SavePreference("quickCommands", string(raw)); err != nil {
		t.Fatal(err)
	}
	state, err = a.State()
	if err != nil {
		t.Fatal(err)
	}
	if state.QuickCommands[0].Command != "uptime" {
		t.Fatal("new command without trailing newline unexpectedly runs")
	}
}

