package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

func TestAIConversationsIgnoreEmptyDrafts(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil { t.Fatal(err) }
	defer s.Close()
	if err := s.InitAI(ctx); err != nil { t.Fatal(err) }

	if err := s.SaveAIConversation(ctx, AIConversation{ID: "empty"}); err == nil {
		t.Fatal("empty conversation should not be saved")
	}
	if _, err := s.GetAIConversation(ctx, "empty"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("empty conversation persisted: %v", err)
	}

	// Older versions may contain empty conversation rows; keep them in the
	// database but do not display them in the saved history list.
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO ai_conversations(id,data) VALUES(?,?)`,
		"old-empty", `{"id":"old-empty","messages":[]}`); err != nil {
		t.Fatal(err)
	}

	if err := s.SaveAIConversation(ctx, AIConversation{
		ID: "with-messages",
		Messages: []AIMessage{{Role: "user", Content: "检查磁盘"}},
	}); err != nil {
		t.Fatal(err)
	}
	conversations, err := s.AIConversations(ctx)
	if err != nil { t.Fatal(err) }
	if len(conversations) != 1 || conversations[0].ID != "with-messages" {
		t.Fatalf("unexpected visible conversations: %#v", conversations)
	}
}
