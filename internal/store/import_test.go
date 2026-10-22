package store

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/hctty27/openshell/internal/domain"
)

func TestImportSessionsAtomicRollback(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil { t.Fatal(err) }
	defer db.Close()
	ctx := context.Background()
	g := domain.Group{ID:"prod", Name:"Production"}
	if err := db.ImportSessions(ctx, []domain.Group{g}, []domain.Session{{ID:"bad",Name:"bad",Port:22,Username:"root"}}); err == nil {
		t.Fatal("expected invalid session")
	}
	groups, err := db.ListGroups(ctx)
	if err != nil { t.Fatal(err) }
	if len(groups) != 0 { t.Fatal("partial import must roll back") }

	s := domain.Session{ID:"good",GroupID:"prod",Name:"server",Host:"example.com",Port:22,Username:"root",AuthType:"password"}
	if err := db.ImportSessions(ctx, []domain.Group{g}, []domain.Session{s}); err != nil { t.Fatal(err) }
	sessions, err := db.ListSessions(ctx)
	if err != nil { t.Fatal(err) }
	if len(sessions) != 1 || sessions[0].CredentialRef != "" { t.Fatal("session not imported safely") }
}
