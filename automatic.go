package main

import (
	"context"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
	"github.com/hctty27/openshell/internal/tasks"
	"strconv"
)

type automaticProfile struct {
	language string
	profile  domain.APIProfile
	key      string
}

func (a *App) automaticSettings() (int, bool, error) {
	raw, err := a.store.GetPreference(a.ctx, "autoCommandLimit")
	if err != nil {
		return 0, false, err
	}
	limit, _ := strconv.Atoi(raw)
	if limit < 1 || limit > 100 {
		limit = 10
	}
	allow, err := a.store.GetPreference(a.ctx, "autoAllowChanges")
	return limit, allow == "true", err
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
	limit, allow, err := a.automaticSettings()
	if err != nil {
		return tasks.AutoSnapshot{}, err
	}
	language, err := a.language()
	if err != nil {
		return tasks.AutoSnapshot{}, err
	}
	req.Operate = true
	err = a.automatic.Start(a.ctx, taskID, req.Ref, limit, allow, tasks.AutoCallbacks{
		Valid: a.ssh.Valid,
		Model: func(ctx context.Context, first bool) (tasks.AutoReply, error) {
			response, e := a.chatContext(ctx, req, !first, true, &automaticProfile{profile: profile, key: key, language: language})
			return tasks.AutoReply{Text: response.Text, Proposal: response.Proposal}, e
		},
		Execute: func(ctx context.Context, p domain.Proposal) (domain.CommandResult, error) {
			return a.confirmCommandContext(ctx, p.ID)
		},
		CancelProposal: func(id string) { a.CancelCommand(id) },
		Emit:           func(event tasks.AutoEvent) { a.emit("auto:event", event) },
	})
	if err != nil {
		return tasks.AutoSnapshot{}, err
	}
	return a.automatic.Run(taskID, "", false)
}
func (a *App) ResumeAutomatic(taskID, approvedProposalID string, extend bool) (tasks.AutoSnapshot, error) {
	return a.automatic.Run(taskID, approvedProposalID, extend)
}
func (a *App) StopAutomatic(taskID string) { a.automatic.Stop(taskID) }
