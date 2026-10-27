package main

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "strings"
    "github.com/hctty27/openshell/internal/ai"
    "github.com/hctty27/openshell/internal/domain"
)

// stableCommandLabel never stores raw shell arguments (which can contain
// credentials or other data the generic redactor cannot recognize).
func stableCommandLabel(command string) string {
    digest := sha256.Sum256([]byte(command))
    label := "shell"
    words := strings.Fields(command)
    if len(words) > 0 {
        switch words[0] {
        case "supervisorctl", "systemctl", "docker", "docker-compose", "ps", "ls", "df", "free", "cat", "grep", "ss", "journalctl", "hostname", "uname", "pwd", "mkdir":
            label = words[0]
        }
    }
    return label + " · " + hex.EncodeToString(digest[:6])
}

func (a *App) ListOperationSteps(ref domain.ConnectionRef, conversationID string) ([]domain.OperationStep, error) {
    return a.memory.ListOperations(a.ctx, ref, conversationID)
}

func (a *App) recordOperation(ctx context.Context, run domain.ConversationRun, proposal domain.Proposal) error {
    targets := proposal.Targets
    if len(targets) == 0 { targets = []domain.ConnectionRef{proposal.Ref} }
    step := domain.OperationStep{
        ID: proposal.ID, RunID: run.ID, ConversationID: run.ConversationID,
        Command: stableCommandLabel(proposal.Command),
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
