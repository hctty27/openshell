package main

import (
    "context"
    "time"

    "github.com/hctty27/openshell/internal/apperror"
    "github.com/hctty27/openshell/internal/domain"
    "github.com/hctty27/openshell/internal/ops"
)

// InspectProposalPreflight uses only fixed read-only commands. Results are not
// treated as authorization for a write, nor as proof of backup/rollback safety.
func (a *App) InspectProposalPreflight(ref domain.ConnectionRef, proposalID string) (ops.PreflightReport, error) {
    run, err := a.checkProposalOwner(ref, proposalID)
    if err!=nil { return ops.PreflightReport{}, err }
    p, err := a.coordinator.Get(proposalID)
    if err!=nil { return ops.PreflightReport{}, err }
    if p.Status!="awaiting_confirmation" { return ops.PreflightReport{}, apperror.New("proposalAlreadyHandledOrExpired", nil) }
    ctx, done, err := a.operation(run)
    if err!=nil { return ops.PreflightReport{}, err }
    defer done()
    targets:=[]domain.ConnectionRef{p.Ref}
    if len(p.Targets)>0 { targets=append([]domain.ConnectionRef(nil),p.Targets...) }
    // Bind the immutable proposal targets to the run's original authorization.
    allowed:=map[domain.ConnectionRef]bool{}
    for _, target:=range a.runTargets(run.ID) { allowed[target]=true }
    for _, target:=range targets {
        if !allowed[target] { return ops.PreflightReport{}, apperror.New("memoryNotOwner", nil) }
    }
    deadline, cancel:=context.WithTimeout(ctx, 20*time.Second)
    defer cancel()
    return ops.Inspect(deadline, proposalID, targets, a.ssh.Valid, a.ssh.Run), nil
}
