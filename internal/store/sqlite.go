package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"time"
)

type Store struct{ db *sql.DB }

func Open(path string) (*Store, error) {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return nil, e
	}
	db, e := sql.Open("sqlite", path)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	s := &Store{db}
	_, e = db.Exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS hostkeys(address TEXT PRIMARY KEY,key BLOB NOT NULL);CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);`)
	if e != nil {
		db.Close()
		return nil, e
	}
	if e = s.migrateConversations(); e != nil {
		db.Close()
		return nil, e
	}
	return s, nil
}
func (s *Store) Close() error { return s.db.Close() }
func list[T any](ctx context.Context, db *sql.DB, query string) ([]T, error) {
	rows, e := db.QueryContext(ctx, query)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	result := []T{}
	for rows.Next() {
		var data string
		var v T
		if e = rows.Scan(&data); e != nil {
			return nil, e
		}
		if e = json.Unmarshal([]byte(data), &v); e != nil {
			return nil, e
		}
		result = append(result, v)
	}
	return result, rows.Err()
}
func (s *Store) save(ctx context.Context, query, id string, value any) error {
	b, e := json.Marshal(value)
	if e != nil {
		return e
	}
	_, e = s.db.ExecContext(ctx, query, id, string(b))
	return e
}
func (s *Store) ListSessions(ctx context.Context) ([]domain.Session, error) {
	return list[domain.Session](ctx, s.db, "SELECT data FROM sessions ORDER BY id")
}
func (s *Store) GetSession(ctx context.Context, id string) (domain.Session, error) {
	var data string
	var v domain.Session
	e := s.db.QueryRowContext(ctx, "SELECT data FROM sessions WHERE id=?", id).Scan(&data)
	if e != nil {
		return v, e
	}
	e = json.Unmarshal([]byte(data), &v)
	return v, e
}
func (s *Store) SaveSession(ctx context.Context, v domain.Session) error {
	if e := domain.ValidateSession(v); e != nil {
		return e
	}
	if v.ID == "" {
		return apperror.New("missingSessionId", nil)
	}
	v.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if v.CreatedAt == "" {
		v.CreatedAt = v.UpdatedAt
	}
	return s.save(ctx, "INSERT INTO sessions(id,data)VALUES(?,?) ON CONFLICT(id)DO UPDATE SET data=excluded.data", v.ID, v)
}
func (s *Store) DeleteSession(ctx context.Context, id string) error {
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	for _, query := range []string{
		"DELETE FROM conversation_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE session_id=?)",
		"DELETE FROM conversation_selections WHERE last_conversation_id IN (SELECT id FROM conversations WHERE session_id=?)",
		"DELETE FROM conversations WHERE session_id=?", "DELETE FROM sessions WHERE id=?",
	} {
		if _, e = tx.ExecContext(ctx, query, id); e != nil {
			return e
		}
	}
	return tx.Commit()
}
func (s *Store) ListGroups(ctx context.Context) ([]domain.Group, error) {
	return list[domain.Group](ctx, s.db, "SELECT data FROM groups ORDER BY id")
}
func (s *Store) SaveGroup(ctx context.Context, v domain.Group) error {
	if v.ID == "" || v.Name == "" {
		return apperror.New("folderNameCannotBeEmpty", nil)
	}
	return s.save(ctx, "INSERT INTO groups(id,data)VALUES(?,?) ON CONFLICT(id)DO UPDATE SET data=excluded.data", v.ID, v)
}
func (s *Store) DeleteGroup(ctx context.Context, id string) error {
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	_, e = tx.ExecContext(ctx, "UPDATE sessions SET data=json_set(data,'$.groupId','') WHERE json_extract(data,'$.groupId')=?", id)
	if e != nil {
		return e
	}
	_, e = tx.ExecContext(ctx, "DELETE FROM groups WHERE id=?", id)
	if e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Store) ListAPIProfiles(ctx context.Context) ([]domain.APIProfile, error) {
	return list[domain.APIProfile](ctx, s.db, "SELECT data FROM profiles ORDER BY id")
}
func (s *Store) GetAPIProfile(ctx context.Context, id string) (domain.APIProfile, error) {
	var data string
	var v domain.APIProfile
	e := s.db.QueryRowContext(ctx, "SELECT data FROM profiles WHERE id=?", id).Scan(&data)
	if e != nil {
		return v, e
	}
	e = json.Unmarshal([]byte(data), &v)
	return v, e
}
func (s *Store) SaveAPIProfile(ctx context.Context, v domain.APIProfile) error {
	return s.save(ctx, "INSERT INTO profiles(id,data)VALUES(?,?) ON CONFLICT(id)DO UPDATE SET data=excluded.data", v.ID, v)
}
func (s *Store) DeleteAPIProfile(ctx context.Context, id string) error {
	_, e := s.db.ExecContext(ctx, "DELETE FROM profiles WHERE id=?", id)
	return e
}
func (s *Store) GetPreference(ctx context.Context, key string) (string, error) {
	var value string
	e := s.db.QueryRowContext(ctx, "SELECT value FROM preferences WHERE key=?", key).Scan(&value)
	if errors.Is(e, sql.ErrNoRows) {
		e = nil
	}
	return value, e
}
func (s *Store) SetPreference(ctx context.Context, key, value string) error {
	_, e := s.db.ExecContext(ctx, "INSERT INTO preferences(key,value)VALUES(?,?) ON CONFLICT(key)DO UPDATE SET value=excluded.value", key, value)
	return e
}
func (s *Store) Lookup(address string) ([]byte, error) {
	var key []byte
	e := s.db.QueryRow("SELECT key FROM hostkeys WHERE address=?", address).Scan(&key)
	if errors.Is(e, sql.ErrNoRows) {
		return nil, nil
	}
	return key, e
}
func (s *Store) Trust(address string, key []byte) error {
	_, e := s.db.Exec("INSERT INTO hostkeys(address,key)VALUES(?,?) ON CONFLICT(address)DO UPDATE SET key=excluded.key", address, key)
	return e
}
func (s *Store) SaveSessionWithSecret(ctx context.Context, v domain.Session, value string, save bool, secret domain.SecretStore) (domain.Session, error) {
	if e := domain.ValidateSession(v); e != nil {
		return v, e
	}
	if v.ID == "" {
		v.ID = domain.NewID()
	}
	old, _ := s.GetSession(ctx, v.ID)
	v.CredentialRef = old.CredentialRef
	if old.AuthType != v.AuthType || old.PrivateKeyPath != v.PrivateKeyPath || old.Host != v.Host || old.Username != v.Username || old.Port != v.Port {
		v.CredentialRef = ""
	}
	if value != "" && save {
		v.CredentialRef = "session-" + domain.NewID()
		if e := secret.Put(ctx, v.CredentialRef, value); e != nil {
			return v, domain.Error("vault", apperror.New("vaultSave", nil).Error())
		}
	} else if !save {
		v.CredentialRef = ""
	}
	if e := s.SaveSession(ctx, v); e != nil {
		if v.CredentialRef != old.CredentialRef && v.CredentialRef != "" {
			secret.Delete(ctx, v.CredentialRef)
		}
		return v, e
	}
	if old.CredentialRef != "" && old.CredentialRef != v.CredentialRef {
		if e := secret.Delete(ctx, old.CredentialRef); e != nil {
			return v, domain.Error("cleanup", apperror.New("sessionCleanup", nil).Error())
		}
	}
	return v, nil
}
