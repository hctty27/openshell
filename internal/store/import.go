package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/hctty27/openshell/internal/domain"
)

// ImportSessions commits folders and SSH profiles atomically. Imported credentials are never saved.
func (s *Store) ImportSessions(ctx context.Context, groups []domain.Group, sessions []domain.Session) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil { return err }
	defer tx.Rollback()
	now := time.Now().UTC().Format(time.RFC3339)
	for _, g := range groups {
		if g.ID == "" || g.Name == "" { return sql.ErrNoRows }
		data, err := json.Marshal(g)
		if err != nil { return err }
		if _, err = tx.ExecContext(ctx, "INSERT INTO groups(id,data) VALUES(?,?)",g.ID,string(data)); err != nil { return err }
	}
	for _, v := range sessions {
		if err := domain.ValidateSession(v); err != nil { return err }
		if v.ID == "" || v.CredentialRef != "" { return sql.ErrNoRows }
		v.CreatedAt, v.UpdatedAt = now, now
		data, err := json.Marshal(v)
		if err != nil { return err }
		if _, err = tx.ExecContext(ctx, "INSERT INTO sessions(id,data) VALUES(?,?)", v.ID, string(data)); err != nil { return err }
	}
	return tx.Commit()
}
