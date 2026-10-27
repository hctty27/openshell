package main

import (
	"context"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
	"github.com/hctty27/openshell/internal/tasks"
	"strconv"
)

type automaticProfile struct {
	runID    string
	language string
	profile  domain.APIProfile
	key      string
}

func (a *App) automaticSettings() (int, bool, bool, error) {
	raw, err := a.store.GetPreference(a.ctx, "autoCommandLimit")
	if err != nil {
		return 0, false, false, err
	}
	limit, _ := strconv.Atoi(raw)
	if limit < 1 || limit > 100 {
		limit = 50
	}
	allow, err := a.store.GetPreference(a.ctx, "autoAllowChanges")
	if err != nil {
        return 0, false, false, err
    }
    rawContinue, err := a.store.GetPreference(a.ctx, "autoContinueRounds")
    return limit, allow == "true", rawContinue != "false", err
}
func (a *App) StartAutomatic(req ChatRequest, taskID string) (tasks.AutoSnapshot, error) {
	if !a.ssh.Valid(req.Ref) {
		return tasks.AutoSnapshot{}, apperror.New("sshDisconnectedOrConnectionChanged", nil)
	}
	profile, key, err := a.profile(req.ProfileID)
	if err != nil {
		return tasks.AutoSnapshot{}, err
	}
	if !profile.ToolsEnabled {
		return tasks.AutoSnapshot{}, apperror.New("enableApiToolCallsToUseAutomaticMode", nil)
	}
	limit, allow, autoContinue, err := a.automaticSettings()
	if err != nil {
		return tasks.AutoSnapshot{}, err
	}
	language, err := a.language()
	if err != nil {
		return tasks.AutoSnapshot{}, err
	}
	run, err := a.startExecutionWithTargets(req.Ref, "auto", taskID, req.Targets)
	if err != nil {
		return tasks.AutoSnapshot{}, err
	}
	req.Operate = true
	err = a.registerAutomatic(run, taskID, limit, allow, tasks.AutoCallbacks{
		Valid: a.ssh.Valid,
		Authorized: func(target domain.ConnectionRef) bool {
			if !a.ssh.Valid(target) { return false }
			for _, ref := range a.runTargets(run.ID) {
				if target == ref { return true }
			}
			return false
		},
		Model: func(ctx context.Context, first bool) (tasks.AutoReply, error) {
			response, e := a.chatContext(ctx, req, !first, true, &automaticProfile{runID: run.ID, profile: profile, key: key, language: language})
			return tasks.AutoReply{Text: response.Text, Proposal: response.Proposal}, e
		},
		Execute: func(ctx context.Context, p domain.Proposal) (domain.CommandResult, error) {
			return a.confirmCommandContext(ctx, p.ID)
		},
        MarkChecked: func(ctx context.Context, stepID string) error {
            if err := a.memory.MarkOperationChecked(ctx, run.ID, stepID); err != nil {
                return err
            }
            a.emit("ops:changed", map[string]any{"conversationId": run.ConversationID})
            return nil
        },
		CancelProposal: func(id string) { a.cancelCommand(id) },
		Emit: func(event tasks.AutoEvent) {
			a.emit("auto:event", event)
			status := event.State.Status
			if status == "completed" || status == "stopped" || status == "error" {
				a.finishExecution(run.ID)
			} else {
				a.memory.SetStatus(run.ID, status)
			}
		},
	})
	if err != nil {
        a.finishExecution(run.ID)
        return tasks.AutoSnapshot{}, err
    }
    if err = a.automatic.SetAutoContinue(taskID, autoContinue); err != nil {
        a.cancelRun(run.ID, req.Ref, false)
        return tasks.AutoSnapshot{}, err
    }
    return a.automatic.Run(taskID, "", false)
}
func (a *App) ResumeAutomatic(ref domain.ConnectionRef, taskID, approvedProposalID string, extend bool) (tasks.AutoSnapshot, error) {
	if _, err := a.automaticExecution(ref, taskID); err != nil {
		return tasks.AutoSnapshot{}, err
	}
	return a.automatic.Run(taskID, approvedProposalID, extend)
}
func (a *App) StopAutomatic(ref domain.ConnectionRef, taskID string) error {
	run, err := a.automaticExecution(ref, taskID)
	if err != nil {
		return err
	}
	a.cancelRun(run.ID, ref, false)
	return nil
}

func (a *App) registerAutomatic(run domain.ConversationRun, taskID string, limit int, allow bool, callbacks tasks.AutoCallbacks) error {
	a.executionMu.Lock()
	defer a.executionMu.Unlock()
	ex := a.executions[run.ID]
	if ex == nil || ex.Ending || ex.Ctx.Err() != nil || ex.TaskID != taskID {
		return apperror.New("memoryNoRun", nil)
	}
	return a.automatic.Start(ex.Ctx, taskID, run.OwnerRef, limit, allow, callbacks)
}
