package main

import (
    "context"
    "github.com/hctty27/openshell/internal/ai"
    "github.com/hctty27/openshell/internal/domain"
)

func (a *App) ListOperationSteps(ref domain.ConnectionRef, conversationID string) ([]domain.OperationStep, error) {
    return a.memory.ListOperations(a.ctx, ref, conversationID)
}

func (a *App) recordOperation(ctx context.Context, run domain.ConversationRun, proposal domain.Proposal) error {
    targets := proposal.Targets
    if len(targets) == 0 { targets = []domain.ConnectionRef{proposal.Ref} }
    step := domain.OperationStep{
        ID: proposal.ID, RunID: run.ID, ConversationID: run.ConversationID,
        Command: ai.Redact(proposal.Command), Purpose: ai.Redact(proposal.Purpose),
        Targets: append([]domain.ConnectionRef(nil), targets...),
        Status: "awaiting_confirmation", Risk: "high",
    }
    if proposal.Plan != nil {
        step.Risk = proposal.Plan.Risk
        step.Preflight = append([]string(nil), proposal.Plan.Preflight...)
    }
    if err := a.memory.AppendOperation(ctx, run.ID, step); err != nil { return err }
    a.emit("ops:changed", map[string]any{"conversationId":run.ConversationID})
    return nil
}

func (a *App) operationTransition(ctx context.Context, runID, conversationID, stepID, from, to, verification, reason string, exit *int) error {
    if err := a.memory.TransitionOperation(ctx, runID, stepID, from, to, verification, ai.Redact(reason), exit); err != nil { return err }
    a.emit("ops:changed", map[string]any{"conversationId":conversationID})
    return nil
}
