package main

import (
	"context"
	"encoding/json"
	"errors"
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
func TestEditingOpenSessionIsAllowed(t *testing.T) {
	a, _ := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	defer a.shutdown(context.Background())
	row, e := a.SaveSession(SaveSessionRequest{Session: domain.Session{Host: "old.example", Port: 22, Username: "root"}})
	if e != nil {
		t.Fatal(e)
	}
	ref := domain.ConnectionRef{TabID: "tab", SessionID: row.ID, Generation: 1}
	a.tabRefs["tab"] = ref
	row.Host = "new.example"
	saved, e := a.SaveSession(SaveSessionRequest{Session: row})
	if e != nil || saved.Host != "new.example" {
		t.Fatal(saved, e)
	}
	if a.tabRefs["tab"] != ref {
		t.Fatal("saving session configuration changed active tab reference")
	}
}
func TestExecFailureStillCompletesToolHistory(t *testing.T) {
	a, _, connected, _, profile, _ := memoryFixture(t, true)
	a.coordinator = tasks.NewCoordinator(func(context.Context, domain.ConnectionRef, string, string, time.Duration) (domain.CommandResult, error) {
		return domain.CommandResult{Status: "unknown", Reason: "start_failed"}, errors.New("channel rejected")
	}, func(domain.ConnectionRef) bool { return true })
	reply, err := a.Chat(ChatRequest{Ref: connected.Ref, ProfileID: profile.ID, Text: "check", Operate: true})
	if err != nil {
		t.Fatal(err)
	}
	a.ConfirmCommand(connected.Ref, reply.Proposal.ID)
	page, err := a.ReadConversation(connected.Ref, connected.ConversationID, 0, 100)
	if err != nil || len(page.Messages) != 3 || page.Messages[2].Role != "tool" || page.Messages[2].ToolCallID != "tool-1" {
		t.Fatal("unmatched tool call after exec failure", page, err)
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
	if err != nil {
		t.Fatal(err)
	}
	initial, err := a.State()
	if err != nil {
		t.Fatal(err)
	}
	if initial.AutoCopySelection || initial.RightClickPaste || initial.MiddleClickPaste || initial.LogHighlights || initial.SplitRatio != 50 || !initial.ConfirmMultilinePaste {
		t.Fatalf("unexpected clipboard defaults: %+v", initial)
	}
	for key, value := range map[string]string{
		"autoCopySelection":     "true",
		"rightClickPaste":       "true",
		"confirmMultilinePaste": "false",
		"middleClickPaste":       "true",
		"logHighlights":          "true",
		"splitRatio":             "70",
	} {
		if err := a.SavePreference(key, value); err != nil {
			t.Fatal(err)
		}
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
	if !state.AutoCopySelection || !state.RightClickPaste || !state.MiddleClickPaste || !state.LogHighlights || state.SplitRatio != 70 || state.ConfirmMultilinePaste {
		t.Fatalf("clipboard settings not restored: %+v", state)
	}
	if err := b.SavePreference("rightClickPaste", "invalid"); err == nil {
        t.Fatal("invalid boolean preference accepted")
    }
    for _, invalid := range []string{"19", "81", "invalid"} {
        if err := b.SavePreference("splitRatio", invalid); err == nil {
            t.Fatalf("invalid split ratio %q accepted", invalid)
        }
    }
}

func TestAutomaticSettingsValidationAndRestore(t *testing.T) {
	a, err := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.shutdown(context.Background())
	for _, v := range []string{"0", "101", "bad"} {
		if err = a.SavePreference("autoCommandLimit", v); err == nil {
			t.Fatal("invalid limit accepted", v)
		}
	}
	if err = a.SavePreference("autoCommandLimit", "3"); err != nil {
		t.Fatal(err)
	}
	if err = a.SavePreference("autoAllowChanges", "true"); err != nil {
		t.Fatal(err)
	}
	state, err := a.State()
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(state)
	var fields map[string]any
	json.Unmarshal(data, &fields)
	if fields["autoCommandLimit"] != float64(3) || fields["autoAllowChanges"] != true {
		t.Fatal(fields)
	}
}
