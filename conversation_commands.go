package main

import (
	"context"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
)

func (a *App) ReviseProposal(ref domain.ConnectionRef, id, command, cwd string, seconds int) (domain.Proposal, error) {
	run, err := a.checkProposalOwner(ref, id)
	if err != nil {
		return domain.Proposal{}, err
	}
	if a.automatic.Active(ref.TabID) {
		return domain.Proposal{}, apperror.New("stopTheAutomaticTaskBeforeEditingCommands", nil)
	}
	return a.reviseOwnedProposal(run, id, command, cwd, seconds)
}
func (a *App) reviseOwnedProposal(run domain.ConversationRun, id, command, cwd string, seconds int) (domain.Proposal, error) {
	a.executionMu.Lock()
	defer a.executionMu.Unlock()
	ex := a.executions[run.ID]
	if ex == nil || ex.Ending || ex.Ctx.Err() != nil {
		return domain.Proposal{}, apperror.New("memoryNoRun", nil)
	}
	if ex.Active > 0 {
		return domain.Proposal{}, apperror.New("memoryBusy", nil)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.proposalRuns[id] != run.ID {
		return domain.Proposal{}, apperror.New("memoryNotOwner", nil)
	}
	next, err := a.coordinator.Revise(id, command, cwd, seconds)
	if err != nil {
		return domain.Proposal{}, err
	}
	a.pending[next.ID] = a.pending[id]
	a.proposalRuns[next.ID] = run.ID
	delete(a.pending, id)
	delete(a.proposalRuns, id)
	return next, nil
}

func (a *App) ConfirmCommand(ref domain.ConnectionRef, id string) (domain.CommandResult, error) {
	if _, err := a.checkProposalOwner(ref, id); err != nil {
		return domain.CommandResult{}, err
	}
	if a.automatic.Active(ref.TabID) {
		return domain.CommandResult{}, apperror.New("confirmTheCommandThroughTheAutomaticTask", nil)
	}
	return a.confirmCommandContext(a.ctx, id)
}
func (a *App) confirmCommandContext(parent context.Context, id string) (domain.CommandResult, error) {
	if err := parent.Err(); err != nil {
		return domain.CommandResult{}, err
	}
	p, err := a.coordinator.Get(id)
	if err != nil {
		return domain.CommandResult{}, err
	}
	run, err := a.checkProposalOwner(p.Ref, id)
	if err != nil {
		return domain.CommandResult{}, err
	}
	ctx, done, err := a.operation(run)
	if err != nil {
		return domain.CommandResult{}, err
	}
	defer done()
	// The persisted tool call must still be available before any remote side effect.
	if _, _, err = a.memory.History(ctx, run.ID); err != nil {
		a.finishExecution(run.ID)
		return domain.CommandResult{}, err
	}
	if err = a.memory.SetStatus(run.ID, "executing"); err != nil {
		a.finishExecution(run.ID)
		return domain.CommandResult{}, err
	}
	result, err := a.coordinator.Confirm(ctx, id)
	if result.Status != "" {
		if e := a.finishTool(id, p, result); e != nil {
			err = e
		}
	}
	if err != nil || result.Status == "unknown" || result.Status == "cancelled" {
		a.finishExecution(run.ID)
	} else {
		a.memory.SetStatus(run.ID, "ready")
	}
	a.emit("ai:result", map[string]any{"ref": p.Ref, "proposalId": id, "result": result})
	return result, err
}
func (a *App) finishTool(id string, p domain.Proposal, result domain.CommandResult) error {
	a.mu.Lock()
	callID := a.pending[id]
	runID := a.proposalRuns[id]
	delete(a.pending, id)
	delete(a.proposalRuns, id)
	a.mu.Unlock()
	if callID == "" || runID == "" {
		return nil
	}
	p.ToolCallID = callID
	return a.appendHistory(runID, a.toolMessage(domain.NewID(), p, result))
}
func (a *App) CancelCommand(ref domain.ConnectionRef, id string) error {
	run, err := a.checkProposalOwner(ref, id)
	if err != nil {
		return err
	}
	err = a.cancelCommand(id)
	if run.Kind != "auto" {
		a.finishExecution(run.ID)
	}
	return err
}
func (a *App) cancelCommand(id string) error {
	p, err := a.coordinator.Get(id)
	if err != nil {
		return err
	}
	rejected, err := a.coordinator.CancelWithState(id)
	if err != nil {
		return err
	}
	if rejected {
		return a.finishTool(id, p, domain.CommandResult{Status: "cancelled", Reason: "Command rejected. Nothing was run.", ReasonCode: "commandRejected"})
	}
	return nil
}
