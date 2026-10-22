package conversation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
	"github.com/hctty27/openshell/internal/store"
	"strings"
	"sync"
)

type binding struct {
	Ref     domain.ConnectionRef
	Session domain.Session
	Key, ID string
}
type Service struct {
	mu                        sync.Mutex
	persistent, db, temporary *store.Store
	bindings                  map[string]binding
	runs                      map[string]domain.ConversationRun
	sequences                 map[string]uint64
	selectionSequences        map[string]uint64
	streams                   map[string]domain.ConversationMessage
	emit                      func(domain.ConversationEvent)
}

func NewService(db *store.Store, emit func(domain.ConversationEvent)) *Service {
	if emit == nil {
		emit = func(domain.ConversationEvent) {}
	}
	return &Service{persistent: db, db: db, bindings: map[string]binding{}, runs: map[string]domain.ConversationRun{}, sequences: map[string]uint64{}, selectionSequences: map[string]uint64{}, streams: map[string]domain.ConversationMessage{}, emit: emit}
}
func ServerKey(s domain.Session) string {
	data, _ := json.Marshal([]any{s.ID, strings.ToLower(strings.TrimSpace(s.Host)), s.Port, s.Username})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
func (s *Service) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.temporary != nil {
		s.temporary.Close()
		s.temporary = nil
	}
}
func (s *Service) binding(ref domain.ConnectionRef) (binding, error) {
	b, ok := s.bindings[ref.TabID]
	if !ok || b.Ref != ref {
		return b, apperror.New("memoryConnectionChanged", nil)
	}
	return b, nil
}
func (s *Service) publish(c domain.Conversation, kind string, run *domain.ConversationRun, message *domain.ConversationMessage, status string) {
	s.sequences[c.ID]++
	var selected map[string]string
	var selectedRefs map[string]domain.ConnectionRef
	var selectionRevision uint64
	if kind == "selection" || kind == "created" || kind == "deleted" {
		s.selectionSequences[c.ServerKey]++
		selectionRevision = s.selectionSequences[c.ServerKey]
		selected = map[string]string{}
		selectedRefs = map[string]domain.ConnectionRef{}
		for tab, b := range s.bindings {
			if b.Key == c.ServerKey {
				selected[tab] = b.ID
				selectedRefs[tab] = b.Ref
			}
		}
	}
	s.emit(domain.ConversationEvent{EventID: domain.NewID(), EventSeq: s.sequences[c.ID], ServerKey: c.ServerKey, ConversationID: c.ID, Kind: kind, Revision: c.Revision, Run: run, Message: message, Conversation: &c, SelectedByTab: selected, SelectedRefs: selectedRefs, SelectionRevision: selectionRevision, Status: status})
}
func (s *Service) runFor(id string) *domain.ConversationRun {
	for _, r := range s.runs {
		if r.ConversationID == id {
			v := r
			return &v
		}
	}
	return nil
}
func (s *Service) tabRun(ref domain.ConnectionRef) *domain.ConversationRun {
	for _, r := range s.runs {
		if r.OwnerRef == ref {
			v := r
			return &v
		}
	}
	return nil
}
func (s *Service) bind(ctx context.Context, ref domain.ConnectionRef, row domain.Session) (domain.Conversation, error) {
	key := ServerKey(row)
	id := ""
	if old, ok := s.bindings[ref.TabID]; ok && old.Key == key {
		id = old.ID
	}
	if id == "" {
		var err error
		id, err = s.db.LastConversation(ctx, key)
		if err != nil {
			return domain.Conversation{}, err
		}
	}
	var c domain.Conversation
	var err error
	if id != "" {
		c, err = s.db.GetConversation(ctx, id)
	}
	if id == "" || err != nil {
		list, e := s.db.ListConversations(ctx, key, nil, 1)
		if e != nil {
			return c, e
		}
		if len(list.Items) > 0 {
			c = list.Items[0]
		} else {
			c, err = s.db.CreateConversation(ctx, key, row.ID)
			if err != nil {
				return c, err
			}
		}
	}
	if c.ServerKey != key {
		return c, apperror.New("memoryWrongServer", nil)
	}
	if err = s.db.SelectConversation(ctx, key, c.ID); err != nil {
		return c, err
	}
	s.bindings[ref.TabID] = binding{ref, row, key, c.ID}
	return c, nil
}
func (s *Service) Bind(ctx context.Context, ref domain.ConnectionRef, row domain.Session) (domain.Conversation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, e := s.bind(ctx, ref, row)
	if e == nil {
		s.publish(c, "selection", s.runFor(c.ID), nil, "")
	}
	return c, e
}
func (s *Service) Unbind(ref domain.ConnectionRef) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if b, ok := s.bindings[ref.TabID]; ok && b.Ref == ref {
		delete(s.bindings, ref.TabID)
	}
}
func (s *Service) Selected(ref domain.ConnectionRef) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, e := s.binding(ref)
	return b.ID, e
}
func (s *Service) owned(ctx context.Context, b binding, id string) (domain.Conversation, error) {
	c, e := s.db.GetConversation(ctx, id)
	if e != nil {
		return c, e
	}
	if c.ServerKey != b.Key {
		return c, apperror.New("memoryWrongServer", nil)
	}
	return c, nil
}
func (s *Service) Create(ctx context.Context, ref domain.ConnectionRef) (domain.Conversation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, e := s.binding(ref)
	if e != nil {
		return domain.Conversation{}, e
	}
	if s.tabRun(ref) != nil {
		return domain.Conversation{}, apperror.New("memoryBusy", nil)
	}
	c, e := s.db.CreateConversation(ctx, b.Key, b.Session.ID)
	if e != nil {
		return c, e
	}
	if e = s.db.SelectConversation(ctx, b.Key, c.ID); e != nil {
		return c, e
	}
	b.ID = c.ID
	s.bindings[ref.TabID] = b
	s.publish(c, "created", nil, nil, "")
	return c, nil
}
func (s *Service) Select(ctx context.Context, ref domain.ConnectionRef, id string) (domain.ConversationPage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, e := s.binding(ref)
	if e != nil {
		return domain.ConversationPage{}, e
	}
	if s.tabRun(ref) != nil {
		return domain.ConversationPage{}, apperror.New("memoryBusy", nil)
	}
	c, e := s.owned(ctx, b, id)
	if e != nil {
		return domain.ConversationPage{}, e
	}
	if e = s.db.SelectConversation(ctx, b.Key, id); e != nil {
		return domain.ConversationPage{}, e
	}
	b.ID = id
	s.bindings[ref.TabID] = b
	s.publish(c, "selection", s.runFor(id), nil, "")
	return s.read(ctx, b, id, 0, 100)
}
func (s *Service) List(ctx context.Context, ref domain.ConnectionRef, cursor *domain.ConversationCursor, limit int) (domain.ConversationList, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, e := s.binding(ref)
	if e != nil {
		return domain.ConversationList{}, e
	}
	return s.db.ListConversations(ctx, b.Key, cursor, limit)
}
func (s *Service) read(ctx context.Context, b binding, id string, before int64, limit int) (domain.ConversationPage, error) {
	if _, e := s.owned(ctx, b, id); e != nil {
		return domain.ConversationPage{}, e
	}
	p, e := s.db.ReadConversation(ctx, id, before, limit)
	p.Run = s.runFor(id)
	p.EventSeq = s.sequences[id]
	if before == 0 && p.Run != nil {
		if m, ok := s.streams[p.Run.ID]; ok {
			found := false
			for _, saved := range p.Messages {
				if saved.ID == m.ID {
					found = true
				}
			}
			if !found {
				p.Messages = append(p.Messages, m)
			}
		}
	}
	return p, e
}
func (s *Service) Read(ctx context.Context, ref domain.ConnectionRef, id string, before int64, limit int) (domain.ConversationPage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, e := s.binding(ref)
	if e != nil {
		return domain.ConversationPage{}, e
	}
	return s.read(ctx, b, id, before, limit)
}
func (s *Service) Rename(ctx context.Context, ref domain.ConnectionRef, id, title string) (domain.Conversation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, e := s.binding(ref)
	if e != nil {
		return domain.Conversation{}, e
	}
	if _, e = s.owned(ctx, b, id); e != nil {
		return domain.Conversation{}, e
	}
	if s.runFor(id) != nil {
		return domain.Conversation{}, apperror.New("memoryBusy", nil)
	}
	c, e := s.db.RenameConversation(ctx, id, title)
	if e == nil {
		s.publish(c, "renamed", nil, nil, "")
	}
	return c, e
}
func (s *Service) Clear(ctx context.Context, ref domain.ConnectionRef) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, e := s.binding(ref)
	if e != nil {
		return e
	}
	if s.runFor(b.ID) != nil {
		return apperror.New("memoryBusy", nil)
	}
	c, e := s.owned(ctx, b, b.ID)
	if e != nil {
		return e
	}
	c, e = s.db.MutateConversation(ctx, c.ID, c.Revision, domain.ConversationMutation{Kind: "clear"})
	if e == nil {
		s.publish(c, "cleared", nil, nil, "")
	}
	return e
}
func (s *Service) Delete(ctx context.Context, ref domain.ConnectionRef, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, e := s.binding(ref)
	if e != nil {
		return e
	}
	c, e := s.owned(ctx, b, id)
	if e != nil {
		return e
	}
	if s.runFor(id) != nil {
		return apperror.New("memoryBusy", nil)
	}
	replacement, e := s.db.DeleteAndSelectConversation(ctx, id)
	if e != nil {
		return e
	}
	for tab, v := range s.bindings {
		if v.Key == b.Key && v.ID == id {
			v.ID = replacement.ID
			s.bindings[tab] = v
		}
	}
	s.publish(c, "deleted", nil, nil, "")
	s.publish(replacement, "selection", s.runFor(replacement.ID), nil, "")
	return nil
}
func (s *Service) Begin(ref domain.ConnectionRef, kind string) (domain.ConversationRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, e := s.binding(ref)
	if e != nil {
		return domain.ConversationRun{}, e
	}
	if s.runFor(b.ID) != nil || s.tabRun(ref) != nil {
		return domain.ConversationRun{}, apperror.New("memoryBusy", nil)
	}
	c, e := s.db.GetConversation(context.Background(), b.ID)
	if e != nil {
		return domain.ConversationRun{}, e
	}
	r := domain.ConversationRun{ID: domain.NewID(), ConversationID: b.ID, OwnerRef: ref, Kind: kind, Status: "running"}
	s.runs[r.ID] = r
	s.publish(c, "run", &r, nil, "")
	return r, nil
}
func (s *Service) CurrentRun(ref domain.ConnectionRef) (domain.ConversationRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, e := s.binding(ref); e != nil {
		return domain.ConversationRun{}, e
	}
	if r := s.tabRun(ref); r != nil {
		return *r, nil
	}
	return domain.ConversationRun{}, apperror.New("memoryNoRun", nil)
}
func (s *Service) CheckOwner(id string, ref domain.ConnectionRef) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.runs[id]
	if !ok || r.OwnerRef != ref {
		return apperror.New("memoryNotOwner", nil)
	}
	_, e := s.binding(ref)
	return e
}
func (s *Service) End(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.runs[id]
	if !ok {
		return
	}
	delete(s.runs, id)
	delete(s.streams, id)
	if c, e := s.db.GetConversation(context.Background(), r.ConversationID); e == nil {
		s.publish(c, "run", nil, nil, "")
	}
}
func (s *Service) SetStatus(id, status string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.runs[id]
	if !ok {
		return apperror.New("memoryNoRun", nil)
	}
	r.Status = status
	s.runs[id] = r
	c, e := s.db.GetConversation(context.Background(), r.ConversationID)
	if e == nil {
		s.publish(c, "run", &r, nil, status)
	}
	return e
}
func (s *Service) Append(ctx context.Context, id string, m domain.ConversationMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.runs[id]
	if !ok {
		return apperror.New("memoryNoRun", nil)
	}
	b, e := s.binding(r.OwnerRef)
	if e != nil || b.ID != r.ConversationID {
		return apperror.New("memoryConnectionChanged", nil)
	}
	c, e := s.db.GetConversation(ctx, r.ConversationID)
	if e != nil {
		return e
	}
	c, e = s.db.MutateConversation(ctx, c.ID, c.Revision, domain.ConversationMutation{Kind: "append", Message: &m})
	if e != nil {
		return e
	}
	p, e := s.db.ReadConversation(ctx, c.ID, 0, 100)
	if e != nil {
		return e
	}
	for _, saved := range p.Messages {
		if saved.ID == m.ID {
			delete(s.streams, id)
			s.publish(c, "message", &r, &saved, "")
			break
		}
	}
	return nil
}
func (s *Service) EmitDelta(id, messageID, text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.runs[id]
	if !ok {
		return apperror.New("memoryNoRun", nil)
	}
	c, e := s.db.GetConversation(context.Background(), r.ConversationID)
	if e != nil {
		return e
	}
	s.streams[id] = domain.ConversationMessage{ID: messageID, ConversationID: c.ID, Role: "assistant", Content: text, Status: "streaming"}
	// Cumulative text makes duplicate/out-of-order event delivery idempotent.
	s.publish(c, "stream", &r, &domain.ConversationMessage{ID: messageID, ConversationID: c.ID, Role: "assistant", Content: text, Status: "streaming"}, "")
	return nil
}
func (s *Service) History(ctx context.Context, id string) (domain.Conversation, []domain.ConversationMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.runs[id]
	if !ok {
		return domain.Conversation{}, nil, apperror.New("memoryNoRun", nil)
	}
	c, e := s.db.GetConversation(ctx, r.ConversationID)
	if e != nil {
		return c, nil, e
	}
	all := []domain.ConversationMessage{}
	var before int64
	for {
		page, err := s.db.ReadConversation(ctx, c.ID, before, 100)
		if err != nil {
			return c, nil, err
		}
		all = append(page.Messages, all...)
		if !page.HasMore {
			break
		}
		before = page.BeforeSeq
	}
	return c, all, nil
}
func (s *Service) SaveSummary(ctx context.Context, id string, revision int64, summary string, through int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.runs[id]
	if !ok {
		return apperror.New("memoryNoRun", nil)
	}
	c, e := s.db.MutateConversation(ctx, r.ConversationID, revision, domain.ConversationMutation{Kind: "summary", Summary: summary, SummaryThroughSeq: through})
	if e == nil {
		s.publish(c, "summary", &r, nil, "summary")
	}
	return e
}
func (s *Service) Configure(ctx context.Context, save bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.runs) > 0 {
		return apperror.New("memoryBusy", nil)
	}
	if save == (s.db == s.persistent) {
		return nil
	}
	previousDB, previousBindings := s.db, s.bindings
	previousTemporary := s.temporary
	nextDB := s.persistent
	if !save {
		var err error
		nextDB, err = store.Open(":memory:")
		if err != nil {
			return err
		}
	}
	s.db = nextDB
	s.bindings = map[string]binding{}
	for _, b := range previousBindings {
		if _, err := s.bind(ctx, b.Ref, b.Session); err != nil {
			s.db = previousDB
			s.bindings = previousBindings
			if !save {
				nextDB.Close()
			}
			return err
		}
	}
	if save {
		s.temporary = nil
		if previousTemporary != nil {
			previousTemporary.Close()
		}
	} else {
		s.temporary = nextDB
	}
	for _, b := range s.bindings {
		if c, err := s.db.GetConversation(ctx, b.ID); err == nil {
			s.publish(c, "selection", nil, nil, "")
		}
	}
	return nil
}
