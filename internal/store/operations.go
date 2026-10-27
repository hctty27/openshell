package store

import (
    "context"
    "database/sql"
    "encoding/json"
    "errors"
    "fmt"
    "time"

    "github.com/hctty27/openshell/internal/domain"
)

var ErrOperationTransition = errors.New("operation step changed; refresh before proceeding")

func (s *Store) CreateOperationStep(ctx context.Context, step domain.OperationStep) (domain.OperationStep, error) {
    if step.ID == "" || step.ConversationID == "" || step.RunID == "" || step.Status != "awaiting_confirmation" || len(step.Targets) == 0 {
        return step, ErrOperationTransition
    }
    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil { return step, err }
    defer tx.Rollback()
    var exists int
    if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM conversations WHERE id=?", step.ConversationID).Scan(&exists); err != nil { return step, err }
    if exists != 1 { return step, sql.ErrNoRows }
    if err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(seq),0)+1 FROM operation_steps WHERE conversation_id=?", step.ConversationID).Scan(&step.Sequence); err != nil { return step, err }
    step.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
    step.UpdatedAt = step.CreatedAt
    b, err := json.Marshal(step)
    if err != nil { return step, err }
    if _, err = tx.ExecContext(ctx, "INSERT INTO operation_steps(conversation_id,step_id,seq,data) VALUES(?,?,?,?)", step.ConversationID, step.ID, step.Sequence, string(b)); err != nil { return step, err }
    return step, tx.Commit()
}

// TransitionOperationStep performs an expected-state transition atomically.
// A failed or uncertain remote write must never be retried by the journal.
func (s *Store) TransitionOperationStep(ctx context.Context, conversationID, stepID, from, to, verification, reason string, exitCode *int) error {
    allowed := (from == "awaiting_confirmation" && (to == "running" || to == "cancelled" || to == "superseded")) ||
        (from == "running" && (to == "completed" || to == "failed" || to == "unknown" || to == "cancelled"))
    if !allowed || conversationID == "" || stepID == "" { return ErrOperationTransition }
    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil { return err }
    defer tx.Rollback()
    var raw string
    if err = tx.QueryRowContext(ctx, "SELECT data FROM operation_steps WHERE conversation_id=? AND step_id=?", conversationID, stepID).Scan(&raw); err != nil { return err }
    var step domain.OperationStep
    if err = json.Unmarshal([]byte(raw), &step); err != nil { return err }
    if step.Status != from { return ErrOperationTransition }
    step.Status, step.VerificationStatus, step.Reason, step.ExitCode = to, verification, reason, exitCode
    step.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
    data, err := json.Marshal(step)
    if err != nil { return err }
    result, err := tx.ExecContext(ctx, "UPDATE operation_steps SET data=? WHERE conversation_id=? AND step_id=?", string(data), conversationID, stepID)
    if err != nil { return err }
    affected, err := result.RowsAffected()
    if err != nil || affected != 1 { return fmt.Errorf("%w: missing step", ErrOperationTransition) }
    return tx.Commit()
}

func (s *Store) ListOperationSteps(ctx context.Context, conversationID string) ([]domain.OperationStep, error) {
    if conversationID == "" { return nil, sql.ErrNoRows }
    if _, err := s.GetConversation(ctx, conversationID); err != nil { return nil, err }
    rows, err := s.db.QueryContext(ctx, "SELECT data FROM operation_steps WHERE conversation_id=? ORDER BY seq DESC LIMIT 100", conversationID)
    if err != nil { return nil, err }
    defer rows.Close()
    steps := []domain.OperationStep{}
    for rows.Next() {
        var data []byte
        var step domain.OperationStep
        if err := rows.Scan(&data); err != nil { return nil, err }
        if err := json.Unmarshal(data, &step); err != nil { return nil, err }
        steps = append(steps, step)
    }
    return steps, rows.Err()
}
