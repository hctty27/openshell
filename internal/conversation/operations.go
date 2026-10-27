package conversation

import (
    "context"
    "github.com/hctty27/openshell/internal/apperror"
    "github.com/hctty27/openshell/internal/domain"
)

// AppendOperation uses the same temporary/persistent store as chat history,
// so disabling conversation persistence also disables operation journaling.
func (s *Service) AppendOperation(ctx context.Context, runID string, step domain.OperationStep) error {
    s.mu.Lock()
    defer s.mu.Unlock()
    run, ok := s.runs[runID]
    if !ok || run.ConversationID != step.ConversationID || step.RunID != runID {
        return apperror.New("memoryNoRun", nil)
    }
    if b, err := s.binding(run.OwnerRef); err != nil || b.ID != run.ConversationID {
        return apperror.New("memoryConnectionChanged", nil)
    }
    _, err := s.db.CreateOperationStep(ctx, step)
    return err
}

func (s *Service) TransitionOperation(ctx context.Context, runID, stepID, from, to, verification, reason string, exit *int) error {
    s.mu.Lock()
    defer s.mu.Unlock()
    run, ok := s.runs[runID]
    if !ok { return apperror.New("memoryNoRun", nil) }
    if b, err := s.binding(run.OwnerRef); err != nil || b.ID != run.ConversationID {
        return apperror.New("memoryConnectionChanged", nil)
    }
    return s.db.TransitionOperationStep(ctx, run.ConversationID, stepID, from, to, verification, reason, exit)
}

func (s *Service) MarkOperationChecked(ctx context.Context, runID, stepID string) error {
    s.mu.Lock()
    defer s.mu.Unlock()
    run, ok := s.runs[runID]
    if !ok { return apperror.New("memoryNoRun", nil) }
    if b, err := s.binding(run.OwnerRef); err != nil || b.ID != run.ConversationID {
        return apperror.New("memoryConnectionChanged", nil)
    }
    return s.db.MarkOperationChecked(ctx, run.ConversationID, stepID)
}

func (s *Service) ListOperations(ctx context.Context, ref domain.ConnectionRef, conversationID string) ([]domain.OperationStep, error) {
    s.mu.Lock()
    defer s.mu.Unlock()
    b, err := s.binding(ref)
    if err != nil { return nil, err }
    if _, err = s.owned(ctx, b, conversationID); err != nil { return nil, err }
    return s.db.ListOperationSteps(ctx, conversationID)
}
