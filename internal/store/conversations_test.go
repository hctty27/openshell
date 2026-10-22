package store

import (
	"context"
	"database/sql"
	"github.com/hctty27/openshell/internal/domain"
	"path/filepath"
	"strings"
	"testing"
)

func memoryDB(t *testing.T) (*Store, context.Context) {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, context.Background()
}
func TestConversationMigrationPreservesV1(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec("CREATE TABLE preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO preferences VALUES('language','zh-CN'); PRAGMA user_version=1")
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	for i := 0; i < 2; i++ {
		s, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		var version int
		if err = s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 2 {
			t.Fatalf("version=%d err=%v", version, err)
		}
		value, err := s.GetPreference(context.Background(), "language")
		if err != nil || value != "zh-CN" {
			t.Fatal(value, err)
		}
		s.Close()
	}
}
func TestConversationPersistenceAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.db")
	ctx := context.Background()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.CreateConversation(ctx, "server", "session")
	if err != nil {
		t.Fatal(err)
	}
	c, err = s.MutateConversation(ctx, c.ID, c.Revision, domain.ConversationMutation{Kind: "append", Message: &domain.ConversationMessage{ID: "u", Role: "user", Content: "Redis 排查"}})
	if err != nil {
		t.Fatal(err)
	}
	c, err = s.MutateConversation(ctx, c.ID, c.Revision, domain.ConversationMutation{Kind: "summary", Summary: "Redis uses port 26379", SummaryThroughSeq: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SelectConversation(ctx, "server", c.ID); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	page, err := s.ReadConversation(ctx, c.ID, 0, 100)
	if err != nil || len(page.Messages) != 1 || page.Messages[0].Content != "Redis 排查" || page.Conversation.Summary != c.Summary {
		t.Fatal(page, err)
	}
	last, err := s.LastConversation(ctx, "server")
	if err != nil || last != c.ID {
		t.Fatal(last, err)
	}
}
func TestConversationStablePagination(t *testing.T) {
	s, ctx := memoryDB(t)
	for i := 0; i < 51; i++ {
		if _, err := s.CreateConversation(ctx, "server", "s"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.db.Exec("UPDATE conversations SET updated_at='same'"); err != nil {
		t.Fatal(err)
	}
	first, err := s.ListConversations(ctx, "server", nil, 50)
	if err != nil || len(first.Items) != 50 || first.NextCursor == nil {
		t.Fatal(first, err)
	}
	second, err := s.ListConversations(ctx, "server", first.NextCursor, 50)
	if err != nil || len(second.Items) != 1 || second.NextCursor != nil {
		t.Fatal(second, err)
	}
	seen := map[string]bool{}
	for _, c := range append(first.Items, second.Items...) {
		if seen[c.ID] {
			t.Fatal("duplicate")
		}
		seen[c.ID] = true
	}
	c := first.Items[0]
	for i := 0; i < 101; i++ {
		c, err = s.MutateConversation(ctx, c.ID, c.Revision, domain.ConversationMutation{Kind: "append", Message: &domain.ConversationMessage{ID: domain.NewID(), Role: "user", Content: "x"}})
		if err != nil {
			t.Fatal(err)
		}
	}
	page, err := s.ReadConversation(ctx, c.ID, 0, 100)
	if err != nil || len(page.Messages) != 100 || !page.HasMore || page.Messages[0].Seq != 2 {
		t.Fatal(page, err)
	}
	older, err := s.ReadConversation(ctx, c.ID, page.BeforeSeq, 100)
	if err != nil || len(older.Messages) != 1 || older.Messages[0].Seq != 1 {
		t.Fatal(older, err)
	}
}
func TestConversationRevisionRejectsStaleWrite(t *testing.T) {
	s, ctx := memoryDB(t)
	c, _ := s.CreateConversation(ctx, "server", "s")
	next, err := s.MutateConversation(ctx, c.ID, c.Revision, domain.ConversationMutation{Kind: "clear"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.MutateConversation(ctx, c.ID, c.Revision, domain.ConversationMutation{Kind: "summary", Summary: "stale"})
	if err == nil {
		t.Fatal("stale write accepted")
	}
	got, _ := s.GetConversation(ctx, c.ID)
	if got.Summary != "" || got.Revision != next.Revision {
		t.Fatal(got)
	}
}
func TestConversationIDIsIdempotent(t *testing.T) {
	s, ctx := memoryDB(t)
	c, _ := s.CreateConversation(ctx, "server", "s")
	change := domain.ConversationMutation{Kind: "append", Message: &domain.ConversationMessage{ID: "same", Role: "user", Content: "once"}}
	c, err := s.MutateConversation(ctx, c.ID, c.Revision, change)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.MutateConversation(ctx, c.ID, c.Revision, change)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := s.ReadConversation(ctx, c.ID, 0, 100)
	if len(p.Messages) != 1 {
		t.Fatal(p)
	}
}
func TestConversationClosedDatabaseReturnsError(t *testing.T) {
	s, ctx := memoryDB(t)
	c, _ := s.CreateConversation(ctx, "server", "s")
	s.Close()
	if _, err := s.MutateConversation(ctx, c.ID, c.Revision, domain.ConversationMutation{Kind: "clear"}); err == nil {
		t.Fatal("write failure hidden")
	}
}
func TestConversationTitleUsesRunes(t *testing.T) {
	s, ctx := memoryDB(t)
	c, _ := s.CreateConversation(ctx, "server", "s")
	c, err := s.MutateConversation(ctx, c.ID, c.Revision, domain.ConversationMutation{Kind: "append", Message: &domain.ConversationMessage{ID: "u", Role: "user", Content: strings.Repeat("山😀", 30) + "\nsecond"}})
	if err != nil || len([]rune(c.Title)) != 40 {
		t.Fatal(c, err)
	}
	c, err = s.RenameConversation(ctx, c.ID, "  手动标题  ")
	if err != nil {
		t.Fatal(err)
	}
	c, err = s.MutateConversation(ctx, c.ID, c.Revision, domain.ConversationMutation{Kind: "clear"})
	if err != nil || c.Title != "手动标题" {
		t.Fatal(c, err)
	}
}
func TestConversationDeleteSessionCleansAllHistory(t *testing.T) {
	s, ctx := memoryDB(t)
	c, _ := s.CreateConversation(ctx, "server", "session")
	if err := s.SelectConversation(ctx, "server", c.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteSession(ctx, "session"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetConversation(ctx, c.ID); err == nil {
		t.Fatal("history survived")
	}
	last, err := s.LastConversation(ctx, "server")
	if err != nil || last != "" {
		t.Fatal(last, err)
	}
}
func TestConversationDeleteLastRowIsAtomic(t *testing.T) {
	s, ctx := memoryDB(t)
	c, _ := s.CreateConversation(ctx, "server", "s")
	s.SelectConversation(ctx, "server", c.ID)
	if _, err := s.db.Exec("CREATE TRIGGER fail_delete BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT,'disk full'); END"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DeleteAndSelectConversation(ctx, c.ID); err == nil {
		t.Fatal("failure hidden")
	}
	if _, err := s.GetConversation(ctx, c.ID); err != nil {
		t.Fatal("delete was not rolled back", err)
	}
}
