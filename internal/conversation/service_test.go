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
// Existing-history fixtures explicitly create their first saved conversation.
func bindWithPersist(s *Service, ctx context.Context, ref domain.ConnectionRef, row domain.Session) (domain.Conversation, error) {
	c, err := s.Bind(ctx, ref, row)
	if err != nil || c.ID != "" {
		return c, err
	}
	return s.Create(ctx, ref)
}

func TestTabsShareListsAndChooseIndependently(t *testing.T) {
	s, _, ctx, row, a, b := fixture(t)
	one, e := bindWithPersist(s, ctx, a, row)
	if e != nil {
		t.Fatal(e)
	}
	two, e := bindWithPersist(s, ctx, b, row)
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
	bindWithPersist(s, ctx, a, row)
	bindWithPersist(s, ctx, b, row)
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
	c, _ := bindWithPersist(s, ctx, a, row)
	bindWithPersist(s, ctx, b, row)
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
	original, _ := bindWithPersist(s, ctx, a, row)
	bindWithPersist(s, ctx, b, row)
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
	c, _ := bindWithPersist(s, ctx, a, row)
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
	c, _ := bindWithPersist(s, ctx, a, row)
	run, _ := s.Begin(a, "chat")
	s.EmitDelta(run.ID, "reply", "already streamed")
	bindWithPersist(s, ctx, b, row)
	p, e := s.Read(ctx, b, c.ID, 0, 100)
	if e != nil || len(p.Messages) != 1 || p.Messages[0].Content != "already streamed" {
		t.Fatal(p, e)
	}
}

func TestDraftDoesNotCreateEmptyConversation(t *testing.T) {
	s, db, ctx, row, a, b := fixture(t)
	first, err := s.Bind(ctx, a, row)
	if err != nil || first.ID != "" {
		t.Fatal("first connection should have no saved history", first, err)
	}
	other, err := s.Bind(ctx, b, row)
	if err != nil || other.ID != "" {
		t.Fatal("second connection should also start empty", other, err)
	}
	list, err := db.ListConversations(ctx, ServerKey(row), nil, 50)
	if err != nil || len(list.Items) != 0 {
		t.Fatal("connect created a row", list, err)
	}
	run, err := s.Begin(a, "chat")
	if err != nil {
		t.Fatal(err)
	}
	s.End(run.ID)
	list, err = db.ListConversations(ctx, ServerKey(row), nil, 50)
	if err != nil || len(list.Items) != 0 {
		t.Fatal("failed unsent request left a row", list, err)
	}
	run, err = s.Begin(a, "chat")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Append(ctx, run.ID, domain.ConversationMessage{ID: "user-first", Role: "user", Content: "status"}); err != nil {
		t.Fatal(err)
	}
	s.End(run.ID)
	list, err = db.ListConversations(ctx, ServerKey(row), nil, 50)
	if err != nil || len(list.Items) != 1 {
		t.Fatal("first message not persisted", list, err)
	}
	original := list.Items[0].ID
	if err = s.StartDraft(ctx, a); err != nil {
		t.Fatal(err)
	}
	if err = s.StartDraft(ctx, a); err != nil {
		t.Fatal("repeated plus must be idempotent", err)
	}
	selected, _ := s.Selected(a)
	if selected != "" {
		t.Fatal("draft selected a stored conversation", selected)
	}
	list, _ = db.ListConversations(ctx, ServerKey(row), nil, 50)
	if len(list.Items) != 1 {
		t.Fatal("new blank draft created a row")
	}
	if _, err = s.Select(ctx, b, original); err != nil {
		t.Fatal(err)
	}
	run, err = s.Begin(a, "chat")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Append(ctx, run.ID, domain.ConversationMessage{ID: "user-second", Role: "user", Content: "status again"}); err != nil {
		t.Fatal(err)
	}
	s.End(run.ID)
	list, err = db.ListConversations(ctx, ServerKey(row), nil, 50)
	if err != nil || len(list.Items) != 2 {
		t.Fatal("second draft was not saved on send", list, err)
	}
	selectedB, _ := s.Selected(b)
	if selectedB != original {
		t.Fatal("draft changed peer's selection", selectedB, original)
	}
}

func TestDeletingFinalConversationDoesNotInsertPlaceholder(t *testing.T) {
	s, db, ctx, row, a, _ := fixture(t)
	c, err := bindWithPersist(s, ctx, a, row)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Delete(ctx, a, c.ID); err != nil {
		t.Fatal(err)
	}
	items, err := db.ListConversations(ctx, ServerKey(row), nil, 50)
	if err != nil || len(items.Items) != 0 {
		t.Fatal("deleting last history left a placeholder", items, err)
	}
	selected, err := s.Selected(a)
	if err != nil || selected != "" {
		t.Fatal("last conversation should fall back to draft", selected, err)
	}
}

func TestEmptyBindingAndStorageSwitchEmitDraftSelection(t *testing.T) {
	s, _, ctx, row, a, _ := fixture(t)
	var events []domain.ConversationEvent
	s.emit = func(event domain.ConversationEvent) { events = append(events, event) }
	if _, err := s.Bind(ctx, a, row); err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 || events[0].Conversation != nil || events[0].SelectedByTab[a.TabID] != "" {
		t.Fatal("missing unsaved selection event", events)
	}
	saved, err := s.Create(ctx, a)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Configure(ctx, false); err != nil {
		t.Fatal(err)
	}
	last := events[len(events)-1]
	if last.Conversation != nil || last.SelectedByTab[a.TabID] != "" {
		t.Fatal("switching to unsaved storage did not clear selection", last)
	}
	if err = s.Configure(ctx, true); err != nil {
		t.Fatal(err)
	}
	selected, err := s.Selected(a)
	if err != nil || selected != saved.ID {
		t.Fatal("persisted selection was not restored", selected, err)
	}
}

func TestOperationJournalRespectsEphemeralHistoryMode(t *testing.T) {
    s, db, ctx, row, ref, _ := fixture(t)
    saved, err := bindWithPersist(s, ctx, ref, row)
    if err != nil { t.Fatal(err) }
    if err = s.Configure(ctx, false); err != nil { t.Fatal(err) }
    run, err := s.Begin(ref, "chat")
    if err != nil { t.Fatal(err) }
    step := domain.OperationStep{
        ID:"proposal", ConversationID:run.ConversationID, RunID:run.ID,
        Command:"supervisorctl · digest", Risk:"read", Status:"awaiting_confirmation",
        Targets:[]domain.ConnectionRef{ref},
    }
    if err = s.AppendOperation(ctx, run.ID, step); err != nil { t.Fatal(err) }
    visible, err := s.ListOperations(ctx, ref, run.ConversationID)
    if err != nil || len(visible) != 1 { t.Fatal(visible, err) }
    durable, err := db.ListOperationSteps(ctx, saved.ID)
    if err != nil || len(durable) != 0 { t.Fatalf("ephemeral operation leaked to disk: %+v %v", durable, err) }
    s.End(run.ID)
    if err = s.Configure(ctx, true); err != nil { t.Fatal(err) }
    durable, err = s.ListOperations(ctx, ref, saved.ID)
    if err != nil || len(durable) != 0 { t.Fatal(durable, err) }
}
