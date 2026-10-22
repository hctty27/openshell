package main

import (
	"context"
	"encoding/json"
	"github.com/hctty27/openshell/internal/ai"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
)

type conversationExecution struct {
	Run    domain.ConversationRun
	TaskID string
	Ctx    context.Context
	Cancel context.CancelFunc
	Active int
	Ending bool
	Done   chan struct{}
}

func (a *App) ListConversations(ref domain.ConnectionRef, cursor *domain.ConversationCursor, limit int) (domain.ConversationList, error) {
	return a.memory.List(a.ctx, ref, cursor, limit)
}
func (a *App) CreateConversation(ref domain.ConnectionRef) (domain.Conversation, error) {
	return a.memory.Create(a.ctx, ref)
}
func (a *App) SelectConversation(ref domain.ConnectionRef, id string) (domain.ConversationPage, error) {
	return a.memory.Select(a.ctx, ref, id)
}
func (a *App) ReadConversation(ref domain.ConnectionRef, id string, before int64, limit int) (domain.ConversationPage, error) {
	return a.memory.Read(a.ctx, ref, id, before, limit)
}
func (a *App) RenameConversation(ref domain.ConnectionRef, id, title string) (domain.Conversation, error) {
	return a.memory.Rename(a.ctx, ref, id, title)
}
func (a *App) DeleteConversation(ref domain.ConnectionRef, id string) error {
	return a.memory.Delete(a.ctx, ref, id)
}
func (a *App) startExecution(ref domain.ConnectionRef, kind string) (domain.ConversationRun, error) {
	return a.startExecutionWithTask(ref, kind, "")
}
func (a *App) startExecutionWithTask(ref domain.ConnectionRef, kind, taskID string) (domain.ConversationRun, error) {
	a.executionMu.Lock()
	defer a.executionMu.Unlock()
	if !a.ssh.Valid(ref) || a.closing[ref.TabID] == ref || a.ctx.Err() != nil {
		return domain.ConversationRun{}, apperror.New("memoryConnectionChanged", nil)
	}
	run, err := a.memory.Begin(ref, kind)
	if err != nil {
		return run, err
	}
	ctx, cancel := context.WithCancel(a.ctx)
	a.executions[run.ID] = &conversationExecution{Run: run, TaskID: taskID, Ctx: ctx, Cancel: cancel, Done: make(chan struct{})}
	return run, nil
}
func (a *App) operation(run domain.ConversationRun) (context.Context, func(), error) {
	a.executionMu.Lock()
	defer a.executionMu.Unlock()
	ex := a.executions[run.ID]
	if ex == nil || ex.Ending || ex.Ctx.Err() != nil {
		return nil, nil, apperror.New("memoryNoRun", nil)
	}
	if ex.Active > 0 {
		return nil, nil, apperror.New("memoryBusy", nil)
	}
	ex.Active++
	return ex.Ctx, func() {
		a.executionMu.Lock()
		ex.Active--
		ending := ex.Ending && ex.Active == 0
		a.executionMu.Unlock()
		if ending {
			a.finishExecution(run.ID)
		}
	}, nil
}
func (a *App) finishExecution(id string) {
	a.executionMu.Lock()
	ex := a.executions[id]
	if ex == nil {
		a.executionMu.Unlock()
		return
	}
	ex.Ending = true
	if ex.Active > 0 {
		a.executionMu.Unlock()
		return
	}
	delete(a.executions, id)
	ex.Cancel()
	a.memory.End(id)
	close(ex.Done)
	a.executionMu.Unlock()
}
func (a *App) cancelExecution(ref domain.ConnectionRef, wait bool) {
	a.executionMu.Lock()
	if a.closing[ref.TabID].Generation <= ref.Generation {
		a.closing[ref.TabID] = ref
	}
	var ids []string
	for id, ex := range a.executions {
		if ex.Run.OwnerRef == ref {
			ids = append(ids, id)
		}
	}
	a.executionMu.Unlock()
	for _, id := range ids {
		a.cancelRun(id, ref, wait)
	}
}
func (a *App) cancelRun(id string, ref domain.ConnectionRef, wait bool) {
	a.executionMu.Lock()
	ex := a.executions[id]
	if ex == nil || ex.Run.OwnerRef != ref {
		a.executionMu.Unlock()
		return
	}
	ex.Cancel()
	ex.Ending = true
	done, taskID := ex.Done, ex.TaskID
	a.mu.Lock()
	var proposals []string
	for proposalID, runID := range a.proposalRuns {
		if runID == id {
			proposals = append(proposals, proposalID)
		}
	}
	a.mu.Unlock()
	a.executionMu.Unlock()
	// Cleanup addresses immutable run/proposal IDs, never a replacement run on the same SSH Ref.
	for _, proposalID := range proposals {
		if err := a.cancelCommand(proposalID); err != nil {
			a.emit("conversation:error", map[string]any{"conversationId": ex.Run.ConversationID, "error": err.Error()})
		}
	}
	if taskID != "" {
		a.automatic.Stop(taskID)
	}
	a.finishExecution(id)
	if wait {
		<-done
	}
}
func (a *App) appendHistory(runID string, m domain.ConversationMessage) error {
	safe, err := ai.SanitizeMessage(m)
	if err != nil {
		return err
	}
	return a.memory.Append(context.Background(), runID, safe)
}
func (a *App) checkProposalOwner(ref domain.ConnectionRef, id string) (domain.ConversationRun, error) {
	p, err := a.coordinator.Get(id)
	if err != nil {
		return domain.ConversationRun{}, err
	}
	if p.Ref != ref {
		return domain.ConversationRun{}, apperror.New("memoryNotOwner", nil)
	}
	run, err := a.memory.CurrentRun(ref)
	if err != nil {
		return run, err
	}
	a.mu.Lock()
	proposalRun := a.proposalRuns[id]
	a.mu.Unlock()
	if proposalRun != run.ID {
		return run, apperror.New("memoryNotOwner", nil)
	}
	return run, a.memory.CheckOwner(run.ID, ref)
}
func (a *App) CancelChat(ref domain.ConnectionRef) error {
	run, err := a.memory.CurrentRun(ref)
	if err != nil {
		return err
	}
	a.cancelRun(run.ID, ref, false)
	return nil
}
func (a *App) ClearChat(tabID string) error {
	a.mu.Lock()
	ref := a.tabRefs[tabID]
	a.mu.Unlock()
	return a.memory.Clear(a.ctx, ref)
}
func (a *App) toolMessage(id string, p domain.Proposal, result domain.CommandResult) domain.ConversationMessage {
	display, _ := json.Marshal(map[string]any{"command": p.Command, "result": result})
	return domain.ConversationMessage{ID: id, Role: "tool", ToolCallID: p.ToolCallID, Content: ai.BuildToolResult(p.Command, p.Cwd, result), DisplayJSON: display}
}

func (a *App) automaticExecution(ref domain.ConnectionRef, taskID string) (domain.ConversationRun, error) {
	if err := a.automatic.CheckOwner(taskID, ref); err != nil {
		return domain.ConversationRun{}, err
	}
	run, err := a.memory.CurrentRun(ref)
	if err != nil {
		return run, err
	}
	a.executionMu.Lock()
	defer a.executionMu.Unlock()
	ex := a.executions[run.ID]
	if ex == nil || ex.TaskID != taskID || run.Kind != "auto" {
		return run, apperror.New("memoryNotOwner", nil)
	}
	return run, nil
}
