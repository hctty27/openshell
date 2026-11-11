package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/hctty27/openshell/internal/domain"
	sshclient "github.com/hctty27/openshell/internal/ssh"
	"path/filepath"
	"testing"
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
	if err = a.SavePreference("terminalTheme", "classic"); err != nil {
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
	if decoded["terminalTheme"] != "classic" {
		t.Fatalf("terminal palette not restored: %s", data)
	}
	if err = b.SavePreference("terminalTheme", "invalid"); err == nil {
		t.Fatal("invalid terminal palette accepted")
	}
	if err = b.SavePreference("theme", "invalid"); err == nil {
		t.Fatal("invalid theme accepted")
	}
}


func TestSFTPConcurrencyPreferencePersistsAcrossRestart(t *testing.T) {
    path := filepath.Join(t.TempDir(), "state.db")
    a, err := newApp(path, &vault{m: map[string]string{}}, nil)
    if err != nil { t.Fatal(err) }
    if a.SFTPConcurrency() != 3 { t.Fatalf("unexpected SFTP default: %d", a.SFTPConcurrency()) }
    if err := a.SetSFTPConcurrency(4); err != nil { t.Fatal(err) }
    if err := a.SetSFTPConcurrency(5); err == nil {
        t.Fatal("unsupported SFTP concurrency accepted")
    }
    if a.SFTPConcurrency() != 4 { t.Fatalf("invalid update changed concurrency: %d", a.SFTPConcurrency()) }
    a.shutdown(context.Background())

    b, err := newApp(path, &vault{m: map[string]string{}}, nil)
    if err != nil { t.Fatal(err) }
    defer b.shutdown(context.Background())
    if b.SFTPConcurrency() != 4 {
        t.Fatalf("SFTP concurrency not restored: %d", b.SFTPConcurrency())
    }
}

func TestSessionSidebarPreferences(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	a, err := newApp(path, &vault{m: map[string]string{}}, nil)
	if err != nil { t.Fatal(err) }
	state, err := a.State()
	if err != nil { t.Fatal(err) }
	if state.SessionSidebarMode != "pinned" || state.SessionSidebarWidth != 235 {
		t.Fatalf("unexpected defaults: %s / %d", state.SessionSidebarMode, state.SessionSidebarWidth)
	}
	for _, test := range []struct{ key, value string }{
		{"sessionSidebarMode", "auto-hide"},
		{"sessionSidebarWidth", "318"},
	} {
		if err := a.SavePreference(test.key, test.value); err != nil { t.Fatalf("%s: %v", test.key, err) }
	}
	for _, test := range []struct{ key, value string }{
		{"sessionSidebarMode", "floating"},
		{"sessionSidebarWidth", "189"},
		{"sessionSidebarWidth", "361"},
		{"sessionSidebarWidth", "nope"},
	} {
		if err := a.SavePreference(test.key, test.value); err == nil { t.Fatalf("accepted %s=%s", test.key, test.value) }
	}
	a.shutdown(context.Background())
	b, err := newApp(path, &vault{m: map[string]string{}}, nil)
	if err != nil { t.Fatal(err) }
	defer b.shutdown(context.Background())
	state, err = b.State()
	if err != nil { t.Fatal(err) }
	if state.SessionSidebarMode != "auto-hide" || state.SessionSidebarWidth != 318 {
		t.Fatalf("preferences not restored: %s / %d", state.SessionSidebarMode, state.SessionSidebarWidth)
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
func TestDuplicateSessionCreatesIndependentCredentialsAndNames(t *testing.T) {
	credentials := &vault{m: map[string]string{}}
	a, err := newApp(filepath.Join(t.TempDir(), "state.db"), credentials, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.shutdown(context.Background())
	if err := a.SavePreference("language", "zh-CN"); err != nil {
		t.Fatal(err)
	}

	original, err := a.SaveSession(SaveSessionRequest{
		Session: domain.Session{GroupID: "test", Name: "生产服务器", Host: "127.0.0.1", Port: 2222, Username: "root", AuthType: "password"},
		Secret: "saved-password", SaveSecret: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := a.DuplicateSession(original.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := a.DuplicateSession(original.ID)
	if err != nil {
		t.Fatal(err)
	}
	if first.Name != "生产服务器 - 副本" || second.Name != "生产服务器 - 副本 (2)" {
		t.Fatalf("unexpected duplicate names: %q, %q", first.Name, second.Name)
	}
	if first.ID == original.ID || second.ID == first.ID || first.GroupID != original.GroupID ||
		first.Host != original.Host || first.Port != original.Port ||
		first.Username != original.Username || first.AuthType != original.AuthType {
		t.Fatalf("duplicated session config mismatch: original=%+v first=%+v second=%+v", original, first, second)
	}
	if first.CredentialRef == "" || first.CredentialRef == original.CredentialRef ||
		second.CredentialRef == first.CredentialRef {
		t.Fatal("duplicated session reused saved credential reference")
	}
	if credentials.m[first.CredentialRef] != "saved-password" ||
		credentials.m[second.CredentialRef] != "saved-password" {
		t.Fatal("duplicated session did not copy credentials into separate vault entries")
	}
	if len(a.tabRefs) != 0 {
		t.Fatal("duplicate unexpectedly created an SSH tab")
	}
	if err := a.DeleteSession(first.ID); err != nil {
		t.Fatal(err)
	}
	if credentials.m[original.CredentialRef] != "saved-password" || credentials.m[second.CredentialRef] != "saved-password" {
		t.Fatal("deleting a duplicate changed a different session's credentials")
	}
	if _, err := a.store.GetSession(context.Background(), original.ID); err != nil {
		t.Fatalf("original session was removed: %v", err)
	}
}

func TestDuplicateSessionCopiesKeyConfigButNotTemporarySecret(t *testing.T) {
	credentials := &vault{m: map[string]string{}}
	a, err := newApp(filepath.Join(t.TempDir(), "state.db"), credentials, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.shutdown(context.Background())

	source, err := a.SaveSession(SaveSessionRequest{
		Session: domain.Session{Name: "Key server", Host: "example.org", Port: 22, Username: "deploy", AuthType: "key", PrivateKeyPath: "/test/key"},
		Secret: "temporary-passphrase", SaveSecret: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	copy, err := a.DuplicateSession(source.ID)
	if err != nil {
		t.Fatal(err)
	}
	if copy.Name != "Key server - Copy" || copy.PrivateKeyPath != source.PrivateKeyPath || copy.CredentialRef != "" {
		t.Fatalf("key session config was not copied correctly: %+v", copy)
	}
	if a.transient["session:"+copy.ID] != "" || a.transient["session:"+source.ID] != "temporary-passphrase" {
		t.Fatal("duplicating a key session improperly copied or cleared a transient credential")
	}
	if len(credentials.m) != 0 {
		t.Fatal("duplicate saved a previously temporary credential")
	}
}

func TestDuplicateSessionFailsIfSavedSecretCannotBeRead(t *testing.T) {
	credentials := &vault{m: map[string]string{}}
	a, err := newApp(filepath.Join(t.TempDir(), "state.db"), credentials, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.shutdown(context.Background())
	source, err := a.SaveSession(SaveSessionRequest{
		Session: domain.Session{Name: "Protected", Host: "example.org", Port: 22, Username: "root", AuthType: "password"},
		Secret: "password", SaveSecret: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	delete(credentials.m, source.CredentialRef)
	if _, err := a.DuplicateSession(source.ID); err == nil {
		t.Fatal("duplicated session without a readable saved credential")
	}
	rows, err := a.store.ListSessions(context.Background())
	if err != nil || len(rows) != 1 {
		t.Fatalf("failed duplication left an incomplete session: rows=%+v err=%v", rows, err)
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
	if initial.AutoCopySelection || initial.RightClickPaste || initial.LogHighlights || initial.SplitRatio != 50 || !initial.ConfirmMultilinePaste {
		t.Fatalf("unexpected clipboard defaults: %+v", initial)
	}
	for key, value := range map[string]string{
		"autoCopySelection":     "true",
		"rightClickPaste":       "true",
		"confirmMultilinePaste": "false",
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
	if !state.AutoCopySelection || !state.RightClickPaste || !state.LogHighlights || state.SplitRatio != 70 || state.ConfirmMultilinePaste {
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



func TestTrustHostOnlyAddsFirstFingerprint(t *testing.T) {
	a, err := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.shutdown(context.Background())

	a.challenges["first"] = &sshclient.HostKeyError{
		Address: "server:22",
		Key:     []byte("first-key"),
	}
	if err := a.TrustHost("first"); err != nil {
		t.Fatal(err)
	}
	key, err := a.store.Lookup("server:22")
	if err != nil || string(key) != "first-key" {
		t.Fatalf("first key not trusted: key=%q err=%v", key, err)
	}

	a.challenges["racing-first-use"] = &sshclient.HostKeyError{
		Address: "server:22",
		Key:     []byte("replacement-key"),
	}
	if err := a.TrustHost("racing-first-use"); err == nil {
		t.Fatal("first-use confirmation overwrote a key added by another connection")
	}
	key, err = a.store.Lookup("server:22")
	if err != nil || string(key) != "first-key" {
		t.Fatalf("existing key was overwritten: key=%q err=%v", key, err)
	}
}

func TestUpdateHostFingerprintRequiresConfirmationAndExpectedOldKey(t *testing.T) {
	a, err := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.shutdown(context.Background())

	const address = "server:22"
	if err := a.store.Trust(address, []byte("old-key")); err != nil {
		t.Fatal(err)
	}
	a.challenges["change"] = &sshclient.HostKeyError{
		Address:     address,
		Fingerprint: "new-fingerprint",
		PreviousKey: []byte("old-key"),
		Key:         []byte("new-key"),
		Changed:     true,
	}

	if err := a.UpdateHostFingerprint("change", false); err == nil {
		t.Fatal("fingerprint update accepted without explicit confirmation")
	}
	key, err := a.store.Lookup(address)
	if err != nil || string(key) != "old-key" {
		t.Fatalf("unconfirmed update changed key: key=%q err=%v", key, err)
	}

	if err := a.UpdateHostFingerprint("change", true); err != nil {
		t.Fatal(err)
	}
	key, err = a.store.Lookup(address)
	if err != nil || string(key) != "new-key" {
		t.Fatalf("confirmed update not persisted: key=%q err=%v", key, err)
	}
	if _, ok := a.challenges["change"]; ok {
		t.Fatal("successful challenge was not consumed")
	}
}

func TestUpdateHostFingerprintRejectsStaleChallenge(t *testing.T) {
	a, err := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.shutdown(context.Background())

	const address = "server:22"
	if err := a.store.Trust(address, []byte("old-key")); err != nil {
		t.Fatal(err)
	}
	a.challenges["stale"] = &sshclient.HostKeyError{
		Address:     address,
		PreviousKey: []byte("old-key"),
		Key:         []byte("challenged-key"),
		Changed:     true,
	}
	if err := a.store.Trust(address, []byte("newer-key")); err != nil {
		t.Fatal(err)
	}
	if err := a.UpdateHostFingerprint("stale", true); err == nil {
		t.Fatal("stale challenge replaced a newer trusted key")
	}
	key, err := a.store.Lookup(address)
	if err != nil || string(key) != "newer-key" {
		t.Fatalf("stale challenge overwrote trusted key: key=%q err=%v", key, err)
	}
}
