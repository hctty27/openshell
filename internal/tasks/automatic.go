package tasks

import (
	"context"
	"errors"
	"github.com/hctty27/openshell/internal/domain"
	"strings"
	"sync"
)

type AutoReply struct {
	Text     string
	Proposal *domain.Proposal
}
type AutoSnapshot struct {
	ID           string               `json:"id"`
	Ref          domain.ConnectionRef `json:"ref"`
	Status       string               `json:"status"`
	Steps        int                  `json:"steps"`
	RoundSteps   int                  `json:"roundSteps"`
	Limit        int                  `json:"limit"`
	AllowChanges bool                 `json:"allowChanges"`
	Reason       string               `json:"reason"`
	Proposal     *domain.Proposal     `json:"proposal,omitempty"`
}
type AutoEvent struct {
	Kind      string                `json:"kind"`
	State     AutoSnapshot          `json:"state"`
	MessageID string                `json:"messageId,omitempty"`
	Text      string                `json:"text,omitempty"`
	Result    *domain.CommandResult `json:"result,omitempty"`
}
type AutoCallbacks struct {
	Valid          func(domain.ConnectionRef) bool
	Model          func(context.Context, bool) (AutoReply, error)
	Execute        func(context.Context, domain.Proposal) (domain.CommandResult, error)
	CancelProposal func(string)
	Emit           func(AutoEvent)
}
type automaticTask struct {
	mu            sync.Mutex
	state         AutoSnapshot
	callbacks     AutoCallbacks
	ctx           context.Context
	cancel        context.CancelFunc
	busy, started bool
	messageID     string
	seen          map[string]bool
}
type AutomaticRunner struct {
	mu        sync.Mutex
	tasks     map[string]*automaticTask
	cancelled map[string]bool
}

func NewAutomaticRunner() *AutomaticRunner {
	return &AutomaticRunner{tasks: map[string]*automaticTask{}, cancelled: map[string]bool{}}
}
func (r *AutomaticRunner) Start(parent context.Context, id string, ref domain.ConnectionRef, limit int, allowChanges bool, cb AutoCallbacks) error {
	if id == "" || len(id) > 128 || limit < 1 || limit > 100 {
		return errors.New("无效自动任务或命令上限（1–100）")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cancelled[id] {
		return errors.New("任务已停止")
	}
	if r.tasks[id] != nil {
		return errors.New("任务已存在")
	}
	for key, t := range r.tasks {
		t.mu.Lock()
		active := !autoTerminal(t.state.Status)
		sameTab := t.state.Ref.TabID == ref.TabID
		t.mu.Unlock()
		if sameTab && active {
			return errors.New("此标签已有自动任务")
		}
		if sameTab && !active {
			delete(r.tasks, key)
		}
	}
	ctx, cancel := context.WithCancel(parent)
	r.tasks[id] = &automaticTask{state: AutoSnapshot{ID: id, Ref: ref, Status: "ready", Limit: limit, AllowChanges: allowChanges}, callbacks: cb, ctx: ctx, cancel: cancel, seen: map[string]bool{}}
	return nil
}
func autoTerminal(status string) bool {
	return status == "completed" || status == "stopped" || status == "error"
}
func (r *AutomaticRunner) get(id string) *automaticTask {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.tasks[id]
}
func (t *automaticTask) snapshot() AutoSnapshot { t.mu.Lock(); defer t.mu.Unlock(); return t.state }
func (t *automaticTask) emit(kind, text string, result *domain.CommandResult) {
	t.mu.Lock()
	event := AutoEvent{Kind: kind, State: t.state, MessageID: t.messageID, Text: text, Result: result}
	t.mu.Unlock()
	if t.callbacks.Emit != nil {
		t.callbacks.Emit(event)
	}
}
func (t *automaticTask) finish(status, reason string) AutoSnapshot {
	t.mu.Lock()
	if t.state.Status != "stopped" {
		t.state.Status = status
		t.state.Reason = reason
	}
	state := t.state
	t.mu.Unlock()
	if autoTerminal(state.Status) {
		t.cancel()
	}
	t.emit("state", "", nil)
	return state
}
func (t *automaticTask) live() bool {
	return t.ctx.Err() == nil && t.callbacks.Valid != nil && t.callbacks.Valid(t.state.Ref)
}
func (r *AutomaticRunner) Active(tabID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, t := range r.tasks {
		s := t.snapshot()
		if s.Ref.TabID == tabID && !autoTerminal(s.Status) {
			return true
		}
	}
	return false
}
func (r *AutomaticRunner) Stop(id string) {
	r.mu.Lock()
	t := r.tasks[id]
	if t == nil {
		if len(r.cancelled) >= 100 {
			for key := range r.cancelled {
				delete(r.cancelled, key)
				break
			}
		}
		r.cancelled[id] = true
	}
	r.mu.Unlock()
	if t == nil {
		return
	}
	t.mu.Lock()
	if autoTerminal(t.state.Status) {
		t.mu.Unlock()
		return
	}
	t.state.Status = "stopped"
	t.state.Reason = "已停止，不再执行后续命令"
	p := t.state.Proposal
	t.cancel()
	t.mu.Unlock()
	if p != nil && t.callbacks.CancelProposal != nil {
		t.callbacks.CancelProposal(p.ID)
	}
	t.emit("state", "", nil)
}
func (r *AutomaticRunner) Invalidate(ref domain.ConnectionRef) {
	r.mu.Lock()
	var ids []string
	for id, t := range r.tasks {
		if t.snapshot().Ref == ref {
			ids = append(ids, id)
		}
	}
	r.mu.Unlock()
	for _, id := range ids {
		r.Stop(id)
	}
}
func (r *AutomaticRunner) Run(id, approvedID string, extend bool) (AutoSnapshot, error) {
	t := r.get(id)
	if t == nil {
		return AutoSnapshot{}, errors.New("自动任务不存在")
	}
	t.mu.Lock()
	if t.busy || autoTerminal(t.state.Status) {
		t.mu.Unlock()
		return t.snapshot(), errors.New("任务正在执行或已结束")
	}
	if extend {
		if t.state.Status != "limit" {
			t.mu.Unlock()
			return t.snapshot(), errors.New("当前任务未达到上限")
		}
		t.state.RoundSteps = 0
	}
	if approvedID != "" && (t.state.Status != "awaiting_confirmation" || t.state.Proposal == nil || t.state.Proposal.ID != approvedID) {
		t.mu.Unlock()
		return t.snapshot(), errors.New("确认的命令已变化")
	}
	t.busy = true
	t.state.Status = "running"
	t.state.Reason = ""
	t.mu.Unlock()
	defer func() { t.mu.Lock(); t.busy = false; t.mu.Unlock() }()
	t.emit("state", "", nil)
	for {
		if !t.live() {
			r.Stop(id)
			return t.snapshot(), nil
		}
		s := t.snapshot()
		if s.Proposal == nil {
			t.mu.Lock()
			first := !t.started
			t.started = true
			t.messageID = domain.NewID()
			t.mu.Unlock()
			t.emit("thinking", "", nil)
			reply, err := t.callbacks.Model(t.ctx, first)
			if !t.live() {
				if reply.Proposal != nil && t.callbacks.CancelProposal != nil {
					t.callbacks.CancelProposal(reply.Proposal.ID)
				}
				r.Stop(id)
				return t.snapshot(), nil
			}
			if err != nil {
				return t.finish("error", err.Error()), nil
			}
			if reply.Proposal != nil && reply.Proposal.Ref != s.Ref {
				return t.finish("error", "命令目标与任务连接不一致"), nil
			}
			t.mu.Lock()
			cancelled := t.ctx.Err() != nil
			if !cancelled {
				t.state.Proposal = reply.Proposal
			}
			t.mu.Unlock()
			if cancelled {
				if reply.Proposal != nil && t.callbacks.CancelProposal != nil {
					t.callbacks.CancelProposal(reply.Proposal.ID)
				}
				r.Stop(id)
				return t.snapshot(), nil
			}
			t.emit("reply", reply.Text, nil)
			if reply.Proposal == nil {
				return t.finish("completed", "任务已完成"), nil
			}
			s = t.snapshot()
		}
		if s.RoundSteps >= s.Limit {
			return t.finish("limit", "已达到本轮命令上限，等待你选择继续"), nil
		}
		p := *s.Proposal
		signature := p.Cwd + "\x00" + strings.TrimSpace(p.Command)
		reason := ""
		if !s.AllowChanges && !IsInspectionCommand(p.Command) {
			reason = "此命令未被识别为检查操作，需要确认"
		}
		if t.seen[signature] {
			reason = "重复命令需要确认，避免自动重试"
		}
		if reason != "" && approvedID != p.ID {
			return t.finish("awaiting_confirmation", reason), nil
		}
		approvedID = ""
		t.mu.Lock()
		if t.ctx.Err() != nil {
			t.mu.Unlock()
			r.Stop(id)
			return t.snapshot(), nil
		}
		t.state.Steps++
		t.state.RoundSteps++
		t.seen[signature] = true
		t.mu.Unlock()
		t.emit("executing", "", nil)
		result, err := t.callbacks.Execute(t.ctx, p)
		t.emit("result", "", &result)
		t.mu.Lock()
		t.state.Proposal = nil
		t.mu.Unlock()
		if !t.live() {
			r.Stop(id)
			return t.snapshot(), nil
		}
		if err != nil {
			return t.finish("error", err.Error()), nil
		}
		if result.Status == "unknown" || result.Status == "cancelled" || result.Status == "" {
			return t.finish("stopped", "远端执行结果无法确认，已停止自动任务"), nil
		}
	}
}

func (r *AutomaticRunner) Forget(tabID string) {
	r.mu.Lock()
	var ids []string
	for id, t := range r.tasks {
		if t.snapshot().Ref.TabID == tabID {
			ids = append(ids, id)
		}
	}
	r.mu.Unlock()
	for _, id := range ids {
		r.Stop(id)
		r.mu.Lock()
		delete(r.tasks, id)
		r.mu.Unlock()
	}
}
