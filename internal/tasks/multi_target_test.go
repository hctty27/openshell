package tasks

import (
    "context"
    "strings"
    "sync"
    "sync/atomic"
    "testing"
    "time"

    "github.com/hctty27/openshell/internal/domain"
)

func TestParallelInspectionRunsAllTargetsConcurrently(t *testing.T) {
    refs := []domain.ConnectionRef{
        {TabID: "one", SessionID: "server-a", Generation: 1},
        {TabID: "two", SessionID: "server-b", Generation: 2},
    }
    started := make(chan string, 2)
    release := make(chan struct{})
    var count atomic.Int32
    c := NewCoordinator(func(ctx context.Context, ref domain.ConnectionRef, cmd, cwd string, timeout time.Duration) (domain.CommandResult, error) {
        count.Add(1)
        started <- ref.TabID
        select {
        case <-release:
            return domain.CommandResult{Status: "completed", Stdout: ref.TabID + "-result"}, nil
        case <-ctx.Done():
            return domain.CommandResult{Status: "unknown"}, ctx.Err()
        }
    }, func(domain.ConnectionRef) bool { return true })
    p, err := c.ProposeParallel(refs, "uname -a", "compare systems", "/", 60)
    if err != nil { t.Fatal(err) }
    if count.Load() != 0 { t.Fatal("remote commands ran before approval") }
    completed := make(chan domain.CommandResult, 1)
    go func() { result, _ := c.Confirm(context.Background(), p.ID); completed <- result }()
    for i := 0; i < 2; i++ {
        select {
        case <-started:
        case <-time.After(time.Second * 2):
            close(release)
            t.Fatal("commands were not started concurrently")
        }
    }
    close(release)
    result := <-completed
    if result.Status != "completed" || len(result.TargetResults) != 2 {
        t.Fatalf("unexpected parallel result: %+v", result)
    }
    for i, ref := range refs {
        item := result.TargetResults[i]
        if item.Ref != ref || !strings.Contains(item.Result.Stdout, ref.TabID+"-result") {
            t.Fatalf("result assigned to wrong target: %+v", item)
        }
    }
}

func TestParallelRejectsChangesAndStaleTarget(t *testing.T) {
    a := domain.ConnectionRef{TabID: "a", Generation: 1}
    b := domain.ConnectionRef{TabID: "b", Generation: 1}
    var calls atomic.Int32
    var mu sync.Mutex
    enabled := true
    c := NewCoordinator(func(context.Context, domain.ConnectionRef, string, string, time.Duration) (domain.CommandResult, error) {
        calls.Add(1)
        return domain.CommandResult{Status: "completed"}, nil
    }, func(ref domain.ConnectionRef) bool {
        mu.Lock()
        defer mu.Unlock()
        return ref != b || enabled
    })
    if _, err := c.ProposeParallel([]domain.ConnectionRef{a,b}, "systemctl restart sshd", "change", "/", 60); err == nil {
        t.Fatal("parallel modification accepted")
    }
    if _, err := ParseTool("propose_parallel_inspection", `{"command":"rm -rf /tmp/x","purpose":"cleanup","cwd":"/"}`); err == nil {
        t.Fatal("modification tool was parsed as inspection")
    }
    if _, err := c.ProposeParallel([]domain.ConnectionRef{a,a}, "pwd", "check", "/", 60); err == nil {
        t.Fatal("duplicate target accepted")
    }
    p, err := c.ProposeParallel([]domain.ConnectionRef{a,b}, "pwd", "check", "/", 60)
    if err != nil { t.Fatal(err) }
    mu.Lock(); enabled = false; mu.Unlock()
    if _, err := c.Confirm(context.Background(), p.ID); err == nil { t.Fatal("stale target was not blocked") }
    if calls.Load() != 0 { t.Fatal("executed after a target changed") }
}

func TestParallelConflictsWithSingleProposal(t *testing.T) {
    a := domain.ConnectionRef{TabID: "a", Generation: 1}
    b := domain.ConnectionRef{TabID: "b", Generation: 1}
    c := NewCoordinator(nil, func(domain.ConnectionRef) bool { return true })
    p, err := c.ProposeParallel([]domain.ConnectionRef{a,b}, "pwd", "inspect", "/", 60)
    if err != nil { t.Fatal(err) }
    if _, err := c.Propose(b, "pwd", "inspect", "/", 60); err == nil { t.Fatal("target already reserved") }
    c.Invalidate(b)
    if _, err := c.Confirm(context.Background(), p.ID); err == nil { t.Fatal("invalidated batch accepted") }
    if _, err := c.Revise(p.ID, "pwd", "/", 60); err == nil { t.Fatal("batch unexpectedly editable") }
}
