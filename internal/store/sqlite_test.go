package store

import (
	"context"
	"errors"
	"github.com/hctty27/openshell/internal/domain"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type testSecrets struct {
	values map[string]string
	fail   bool
}

func (s *testSecrets) Get(_ context.Context, k string) (string, error) { return s.values[k], nil }
func (s *testSecrets) Put(_ context.Context, k, v string) error {
	if s.fail {
		return errors.New("unavailable")
	}
	s.values[k] = v
	return nil
}
func (s *testSecrets) Delete(_ context.Context, k string) error { delete(s.values, k); return nil }
func TestPersistenceAcrossRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.db")
	s, e := Open(path)
	if e != nil {
		t.Fatal(e)
	}
	row := domain.Session{ID: "one", Host: "::1", Port: 22, Username: "root", Name: "服务器"}
	if e = s.SaveSession(ctx, row); e != nil {
		t.Fatal(e)
	}
	s.Trust("[::1]:22", []byte("key"))
	s.Close()
	s, e = Open(path)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	rows, _ := s.ListSessions(ctx)
	if len(rows) != 1 || rows[0].Name != row.Name {
		t.Fatal(rows)
	}
	k, _ := s.Lookup("[::1]:22")
	if string(k) != "key" {
		t.Fatal(string(k))
	}
}
func TestNoSecretsInDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	s, _ := Open(path)
	secrets := &testSecrets{values: map[string]string{}}
	row := domain.Session{ID: "one", Host: "host", Port: 22, Username: "root"}
	if _, e := s.SaveSessionWithSecret(context.Background(), row, "super-secret-password", true, secrets); e != nil {
		t.Fatal(e)
	}
	s.Close()
	b, _ := os.ReadFile(path)
	if strings.Contains(string(b), "super-secret-password") {
		t.Fatal("plaintext password persisted")
	}
	if len(secrets.values) != 1 {
		t.Fatal(secrets.values)
	}
}
func TestSecretStoreFailureNoPlaintextFallback(t *testing.T) {
	s, _ := Open(filepath.Join(t.TempDir(), "state.db"))
	defer s.Close()
	sec := &testSecrets{values: map[string]string{}, fail: true}
	_, e := s.SaveSessionWithSecret(context.Background(), domain.Session{ID: "x", Host: "host", Port: 22, Username: "root"}, "secret", true, sec)
	if e == nil {
		t.Fatal("failed to report vault failure")
	}
	rows, _ := s.ListSessions(context.Background())
	if len(rows) != 0 {
		t.Fatal("saved failed reference")
	}
}
func TestWriteFailureCompensatesSecret(t *testing.T) {
	s, _ := Open(filepath.Join(t.TempDir(), "state.db"))
	s.Close()
	sec := &testSecrets{values: map[string]string{}}
	_, e := s.SaveSessionWithSecret(context.Background(), domain.Session{ID: "x", Host: "host", Port: 22, Username: "root"}, "secret", true, sec)
	if e == nil || len(sec.values) != 0 {
		t.Fatalf("error=%v secrets=%v", e, sec.values)
	}
}
func TestAuthenticationChangeClearsOldSecret(t *testing.T) {
	s, _ := Open(filepath.Join(t.TempDir(), "state.db"))
	defer s.Close()
	v := &testSecrets{values: map[string]string{}}
	row, _ := s.SaveSessionWithSecret(context.Background(), domain.Session{ID: "a", Host: "host", Port: 22, Username: "root", AuthType: "password"}, "old-password", true, v)
	row.AuthType = "key"
	row.PrivateKeyPath = "/new-key"
	next, e := s.SaveSessionWithSecret(context.Background(), row, "", true, v)
	if e != nil || next.CredentialRef != "" || len(v.values) != 0 {
		t.Fatal("old password retained for new key", next, e)
	}
}
