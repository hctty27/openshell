package conversation

import (
	"context"
	"github.com/hctty27/openshell/internal/domain"
	"github.com/hctty27/openshell/internal/store"
	"path/filepath"
	"sync"
	"testing"
)

func fixture(t *testing.T) (*Service, *store.Store, context.Context, domain.Session, domain.ConnectionRef, domain.ConnectionRef) {
	t.Helper()
	db, e := store.Open(filepath.Join(t.TempDir(), "memory.db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	s := NewService(db, func(domain.ConversationEvent) {})
	t.Cleanup(func() { s.Close() })
	session := domain.Session{ID: "server", Host: "Example.COM", Port: 22, Username: "root"}
	return s, db, context.Background(), session, domain.ConnectionRef{TabID: "a", SessionID: "server", Generation: 1}, domain.ConnectionRef{TabID: "b", SessionID: "server", Generation: 2}
}
func TestTabsShareListsAndChooseIndependently(t *testing.T) {
	s, _, ctx, row, a, b := fixture(t)
	one, e := s.Bind(ctx, a, row)
	if e != nil {
		t.Fatal(e)
	}
	two, e := s.Bind(ctx, b, row)
	if e != nil || one.ID != two.ID {
		t.Fatal(one, two, e)
	}
	created, e := s.Create(ctx, a)
	if e != nil {
		t.Fatal(e)
	}
	id, _ := s.Selected(b)
	if id != one.ID {
		t.Fatal("observer selection changed")
	}
	list, e := s.List(ctx, b, nil, 50)
	if e != nil || len(list.Items) != 2 {
		t.Fatal(list, e)
	}
	if _, e = s.Select(ctx, b, created.ID); e != nil {
		t.Fatal(e)
	}
	run, e := s.Begin(a, "chat")
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Append(ctx, run.ID, domain.ConversationMessage{ID: "user", Role: "user", Content: "shared"}); e != nil {
		t.Fatal(e)
	}
	page, e := s.Read(ctx, b, created.ID, 0, 100)
	if e != nil || len(page.Messages) != 1 || page.Messages[0].Content != "shared" {
		t.Fatal(page, e)
	}
}
func TestRunLeaseSerializesConversation(t *testing.T) {
	s, _, ctx, row, a, b := fixture(t)
	s.Bind(ctx, a, row)
	s.Bind(ctx, b, row)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var winners []domain.ConversationRun
	for _, ref := range []domain.ConnectionRef{a, b} {
		wg.Add(1)
		go func(ref domain.ConnectionRef) {
			defer wg.Done()
			run, e := s.Begin(ref, "auto")
			if e == nil {
				mu.Lock()
				winners = append(winners, run)
				mu.Unlock()
			}
		}(ref)
	}
	wg.Wait()
	if len(winners) != 1 {
		t.Fatal(winners)
	}
	owner := winners[0].OwnerRef
	other := a
	if other == owner {
		other = b
	}
	if e := s.CheckOwner(winners[0].ID, other); e == nil {
		t.Fatal("observer took control")
	}
	if _, e := s.Select(ctx, owner, winners[0].ConversationID); e == nil {
		t.Fatal("busy owner switched")
	}
	if _, e := s.Create(ctx, other); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Begin(other, "chat"); e != nil {
		t.Fatal(e)
	}
	s.End(winners[0].ID)
	if e := s.Append(ctx, winners[0].ID, domain.ConversationMessage{ID: "late", Role: "assistant"}); e == nil {
		t.Fatal("stale callback accepted")
	}
}
func TestSharedClearAndDeleteFallback(t *testing.T) {
	s, _, ctx, row, a, b := fixture(t)
	c, _ := s.Bind(ctx, a, row)
	s.Bind(ctx, b, row)
	r, _ := s.Begin(a, "chat")
	s.Append(ctx, r.ID, domain.ConversationMessage{ID: "u", Role: "user", Content: "old"})
	s.End(r.ID)
	if e := s.Clear(ctx, b); e != nil {
		t.Fatal(e)
	}
	p, _ := s.Read(ctx, a, c.ID, 0, 100)
	if len(p.Messages) != 0 {
		t.Fatal(p)
	}
	if e := s.Delete(ctx, a, c.ID); e != nil {
		t.Fatal(e)
	}
	idA, _ := s.Selected(a)
	idB, _ := s.Selected(b)
	if idA == c.ID || idA != idB {
		t.Fatal(idA, idB)
	}
}
func TestServerKeyUsesActualIdentity(t *testing.T) {
	_, _, _, row, _, _ := fixture(t)
	key := ServerKey(row)
	row.Name = "renamed"
	row.Host = "example.com"
	if ServerKey(row) != key {
		t.Fatal("display change changed key")
	}
	for _, change := range []func(*domain.Session){func(s *domain.Session) { s.ID = "other" }, func(s *domain.Session) { s.Port = 2222 }, func(s *domain.Session) { s.Username = "deploy" }, func(s *domain.Session) { s.Host = "elsewhere" }} {
		copy := row
		change(&copy)
		if ServerKey(copy) == key {
			t.Fatal("identity collision")
		}
	}
}
func TestEphemeralModeNeverWritesStoredHistory(t *testing.T) {
	s, db, ctx, row, a, b := fixture(t)
	original, _ := s.Bind(ctx, a, row)
	s.Bind(ctx, b, row)
	if e := s.Configure(ctx, false); e != nil {
		t.Fatal(e)
	}
	r, _ := s.Begin(a, "chat")
	s.Append(ctx, r.ID, domain.ConversationMessage{ID: "temp", Role: "user", Content: "do not save"})
	s.End(r.ID)
	page, _ := db.ReadConversation(ctx, original.ID, 0, 100)
	if len(page.Messages) != 0 {
		t.Fatal(page)
	}
	if e := s.Configure(ctx, true); e != nil {
		t.Fatal(e)
	}
	id, _ := s.Selected(a)
	if id != original.ID {
		t.Fatal(id, original.ID)
	}
	p, _ := s.Read(ctx, b, id, 0, 100)
	if len(p.Messages) != 0 {
		t.Fatal(p)
	}
}
func TestStaleSummaryCannotResurrectClearedHistory(t *testing.T) {
	s, _, ctx, row, a, _ := fixture(t)
	c, _ := s.Bind(ctx, a, row)
	r, _ := s.Begin(a, "chat")
	s.End(r.ID)
	if e := s.Clear(ctx, a); e != nil {
		t.Fatal(e)
	}
	next, _ := s.Begin(a, "chat")
	if e := s.SaveSummary(ctx, next.ID, c.Revision, "stale", 1); e == nil {
		t.Fatal("stale summary accepted")
	}
	p, _ := s.Read(ctx, a, c.ID, 0, 100)
	if p.Conversation.Summary != "" {
		t.Fatal(p)
	}
}
func TestNewViewerSnapshotIncludesCurrentStream(t *testing.T) {
	s, _, ctx, row, a, b := fixture(t)
	c, _ := s.Bind(ctx, a, row)
	run, _ := s.Begin(a, "chat")
	s.EmitDelta(run.ID, "reply", "already streamed")
	s.Bind(ctx, b, row)
	p, e := s.Read(ctx, b, c.ID, 0, 100)
	if e != nil || len(p.Messages) != 1 || p.Messages[0].Content != "already streamed" {
		t.Fatal(p, e)
	}
}
