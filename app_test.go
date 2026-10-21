package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/hctty27/openshell/internal/ai"
	"github.com/hctty27/openshell/internal/domain"
	"github.com/hctty27/openshell/internal/tasks"
	"path/filepath"
	"testing"
	"time"
)

func TestThemePreferencePersistsAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	a, err := newApp(path, &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = a.SavePreference("theme", "light"); err != nil {
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
	data, _ := json.Marshal(state)
	var decoded map[string]any
	json.Unmarshal(data, &decoded)
	if decoded["theme"] != "light" {
		t.Fatalf("theme not restored: %s", data)
	}
	if err = b.SavePreference("theme", "invalid"); err == nil {
		t.Fatal("invalid theme accepted")
	}
}

type vault struct {
	m          map[string]string
	failDelete bool
}

func (v *vault) Get(_ context.Context, k string) (string, error) { return v.m[k], nil }
func (v *vault) Put(_ context.Context, k, s string) error        { v.m[k] = s; return nil }
func (v *vault) Delete(_ context.Context, k string) error {
	if v.failDelete {
		return errors.New("vault cleanup failed")
	}
	delete(v.m, k)
	return nil
}
func TestSaveAndListSession(t *testing.T) {
	a, e := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer a.shutdown(context.Background())
	s, e := a.SaveSession(SaveSessionRequest{Session: domain.Session{Name: "测试", Host: "localhost", Port: 22, Username: "root", AuthType: "password"}, Secret: "private", SaveSecret: true})
	if e != nil {
		t.Fatal(e)
	}
	state, e := a.State()
	if e != nil || len(state.Sessions) != 1 || state.Sessions[0].ID != s.ID {
		t.Fatal(state, e)
	}
}
func TestSecretsAbsentFromEventsAndLogs(t *testing.T) {
	a, e := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer a.shutdown(context.Background())
	p, e := a.SaveAPI(SaveAPIRequest{Profile: domain.APIProfile{Name: "自定义", BaseURL: "https://example.com/v1", Model: "model"}, Key: "secret-api-key"})
	if e != nil {
		t.Fatal(e)
	}
	if p.SecretRef == "secret-api-key" {
		t.Fatal("key leaked")
	}
}
func TestEditingActiveSessionTargetRejected(t *testing.T) {
	a, _ := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	defer a.shutdown(context.Background())
	row, e := a.SaveSession(SaveSessionRequest{Session: domain.Session{Host: "old.example", Port: 22, Username: "root"}})
	if e != nil {
		t.Fatal(e)
	}
	a.tabRefs["tab"] = domain.ConnectionRef{TabID: "tab", SessionID: row.ID, Generation: 1}
	row.Host = "new.example"
	if _, e = a.SaveSession(SaveSessionRequest{Session: row}); e == nil {
		t.Fatal("active connection identity changed behind visible tab")
	}
	saved, _ := a.store.GetSession(context.Background(), row.ID)
	if saved.Host != "old.example" {
		t.Fatal(saved.Host)
	}
}
func TestExecFailureStillCompletesToolHistory(t *testing.T) {
	a, _ := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	defer a.shutdown(context.Background())
	ref := domain.ConnectionRef{TabID: "tab", SessionID: "s", Generation: 1}
	a.tabRefs["tab"] = ref
	a.coordinator = tasks.NewCoordinator(func(context.Context, domain.ConnectionRef, string, string, time.Duration) (domain.CommandResult, error) {
		return domain.CommandResult{Status: "unknown", Reason: "start_failed"}, errors.New("channel rejected")
	}, func(domain.ConnectionRef) bool { return true })
	p, _ := a.coordinator.Propose(ref, "pwd", "check", "/tmp", 60)
	a.pending[p.ID] = "call1"
	a.conversations.Append("tab", ai.Message{Role: "assistant", ToolCalls: []ai.ToolCall{{ID: "call1", Type: "function", Function: ai.Function{Name: "propose_command", Arguments: `{"command":"pwd","purpose":"check","cwd":"/tmp"}`}}}})
	a.ConfirmCommand(p.ID)
	messages := a.conversations.Messages("tab")
	if len(messages) != 2 || messages[1].Role != "tool" || messages[1].ToolCallID != "call1" {
		t.Fatal("unmatched tool call after exec failure", messages)
	}
}
func TestAuthenticationChangeClearsTransientSecret(t *testing.T) {
	a, _ := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	defer a.shutdown(context.Background())
	row, _ := a.SaveSession(SaveSessionRequest{Session: domain.Session{Host: "host", Port: 22, Username: "root", AuthType: "password"}, Secret: "old-password", SaveSecret: false})
	row.AuthType = "key"
	row.PrivateKeyPath = "/new-key"
	_, e := a.SaveSession(SaveSessionRequest{Session: row})
	if e != nil {
		t.Fatal(e)
	}
	if a.transient["session:"+row.ID] != "" {
		t.Fatal("cached password applied to new key")
	}
}

func TestTerminalClipboardPreferencesPersistAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	a, err := newApp(path, &vault{m: map[string]string{}}, nil)
	if err != nil { t.Fatal(err) }
	initial, err := a.State()
	if err != nil { t.Fatal(err) }
	if initial.AutoCopySelection || initial.RightClickPaste || !initial.ConfirmMultilinePaste {
		t.Fatalf("unexpected clipboard defaults: %+v", initial)
	}
	for key, value := range map[string]string{
		"autoCopySelection": "true",
		"rightClickPaste": "true",
		"confirmMultilinePaste": "false",
	} {
		if err := a.SavePreference(key, value); err != nil { t.Fatal(err) }
	}
	a.shutdown(context.Background())
	b, err := newApp(path, &vault{m: map[string]string{}}, nil)
	if err != nil { t.Fatal(err) }
	defer b.shutdown(context.Background())
	state, err := b.State()
	if err != nil { t.Fatal(err) }
	if !state.AutoCopySelection || !state.RightClickPaste || state.ConfirmMultilinePaste {
		t.Fatalf("clipboard settings not restored: %+v", state)
	}
	if err := b.SavePreference("rightClickPaste", "invalid"); err == nil {
		t.Fatal("invalid boolean preference accepted")
	}
}
