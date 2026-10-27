package store

import (
    "context"
    "errors"
    "path/filepath"
    "testing"

    "github.com/hctty27/openshell/internal/domain"
)

func TestOperationJournalPersistsAndNeverReplaysInterruptedCommands(t *testing.T) {
    path := filepath.Join(t.TempDir(), "ops.db")
    db, err := Open(path)
    if err != nil { t.Fatal(err) }
    ctx := context.Background()
    conv, err := db.CreateConversation(ctx, "server", "session")
    if err != nil { t.Fatal(err) }
    target := domain.ConnectionRef{TabID: "tab", SessionID: "session", Generation: 1}
    makeStep := func(id string) domain.OperationStep {
        return domain.OperationStep{ID:id, RunID:"run", ConversationID:conv.ID, Command:"supervisorctl ...", Targets:[]domain.ConnectionRef{target}, Risk:"high", Status:"awaiting_confirmation"}
    }
    first, err := db.CreateOperationStep(ctx, makeStep("one"))
    if err != nil || first.Sequence != 1 { t.Fatal(first, err) }
    second, err := db.CreateOperationStep(ctx, makeStep("two"))
    if err != nil || second.Sequence != 2 { t.Fatal(second, err) }
    if _, err = db.CreateOperationStep(ctx, makeStep("one")); err == nil { t.Fatal("duplicate step accepted") }
    if err = db.TransitionOperationStep(ctx, conv.ID, "one", "awaiting_confirmation", "running", "", "", nil); err != nil { t.Fatal(err) }
    if err = db.TransitionOperationStep(ctx, conv.ID, "one", "awaiting_confirmation", "running", "", "", nil); !errors.Is(err, ErrOperationTransition) { t.Fatalf("duplicate start accepted: %v", err) }
    if err = db.Close(); err != nil { t.Fatal(err) }
    db, err = Open(path)
    if err != nil { t.Fatal(err) }
    defer db.Close()
    steps, err := db.ListOperationSteps(ctx, conv.ID)
    if err != nil || len(steps) != 2 { t.Fatal(steps, err) }
    if steps[0].ID != "two" || steps[0].Status != "expired" {
        t.Fatalf("unapproved proposal did not expire: %+v", steps[0])
    }
    if steps[1].ID != "one" || steps[1].Status != "unknown" || steps[1].VerificationStatus != "pending" {
        t.Fatalf("inflight write replay risk: %+v", steps[1])
    }
    if err := db.TransitionOperationStep(ctx, conv.ID, "one", "running", "completed", "", "", nil); !errors.Is(err, ErrOperationTransition) {
        t.Fatalf("interrupted step was allowed to complete after restart: %v", err)
    }
    if err := db.DeleteConversation(ctx, conv.ID); err != nil { t.Fatal(err) }
    if _, err := db.ListOperationSteps(ctx, conv.ID); err == nil { t.Fatal("deleted conversation still available") }
}

func TestOperationJournalTracksVerificationAndPreventsRepeatedEffects(t *testing.T) {
    db, err := Open(":memory:")
    if err != nil { t.Fatal(err) }
    defer db.Close()
    ctx := context.Background()
    c, err := db.CreateConversation(ctx, "server", "one")
    if err != nil { t.Fatal(err) }
    step := domain.OperationStep{ID:"step", RunID:"run", ConversationID:c.ID, Risk:"high", Status:"awaiting_confirmation", Targets:[]domain.ConnectionRef{{TabID:"a"}}}
    if _, err = db.CreateOperationStep(ctx, step); err != nil { t.Fatal(err) }
    if err = db.TransitionOperationStep(ctx, c.ID, step.ID, "awaiting_confirmation", "running", "", "", nil); err != nil { t.Fatal(err) }
    exit := 3
    if err = db.TransitionOperationStep(ctx, c.ID, step.ID, "running", "failed", "pending", "supervisor returned nonzero", &exit); err != nil { t.Fatal(err) }
    steps, err := db.ListOperationSteps(ctx, c.ID)
    if err != nil || len(steps)!=1 || steps[0].ExitCode == nil || *steps[0].ExitCode != 3 || steps[0].VerificationStatus != "pending" { t.Fatalf("%+v %v", steps, err) }
    if err = db.TransitionOperationStep(ctx, c.ID, step.ID, "running", "completed", "", "", nil); !errors.Is(err, ErrOperationTransition) { t.Fatalf("double execution state accepted: %v", err) }
    if err = db.MarkOperationChecked(ctx, c.ID, step.ID); err != nil {
        t.Fatalf("independent verification was not recorded: %v", err)
    }
    if err = db.MarkOperationChecked(ctx, c.ID, step.ID); !errors.Is(err, ErrOperationTransition) {
        t.Fatalf("repeated verification accepted: %v", err)
    }
    steps, err = db.ListOperationSteps(ctx, c.ID)
    if err != nil || steps[0].VerificationStatus != "checked" ||
        steps[0].Status != "failed" || steps[0].ExitCode == nil || *steps[0].ExitCode != exit {
        t.Fatalf("post-inspection journal state incorrect: %+v err=%v", steps, err)
    }
}
