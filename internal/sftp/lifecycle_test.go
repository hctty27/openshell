package sftp

import (
    "context"
    "fmt"
    "testing"
    "time"

    "github.com/hctty27/openshell/internal/domain"
)

func TestTransfersOnlyCurrentConnectionGeneration(t *testing.T) {
    m := testManager()
    ref := domain.ConnectionRef{TabID: "tab", SessionID: "server", Generation: 2}
    stale := ref
    stale.Generation = 1
    m.tasks["old"] = &job{task: Task{ID: "old", Ref: stale, Status: "completed"}}
    m.tasks["new"] = &job{task: Task{ID: "new", Ref: ref, Status: "completed"}}

    got := m.Transfers(ref)
    if len(got) != 1 || got[0].ID != "new" {
        t.Fatalf("unexpected transfers for generation 2: %+v", got)
    }
}

func TestTransferHistoryRetainsOnlyNewestFinishedTasks(t *testing.T) {
    m := testManager()
    for i := 0; i < maxFinishedTransferHistory+5; i++ {
        id := fmt.Sprintf("%04d", i)
        m.tasks[id] = &job{task: Task{ID: id, Status: "completed", Created: int64(i)}}
    }
    m.tasks["active"] = &job{task: Task{ID: "active", Status: "running"}}
    m.mu.Lock()
    m.pruneHistoryLocked()
    m.mu.Unlock()

    if len(m.tasks) != maxFinishedTransferHistory+1 {
        t.Fatalf("expected %d tasks, got %d", maxFinishedTransferHistory+1, len(m.tasks))
    }
    if _, ok := m.tasks["0000"]; ok { t.Fatal("oldest finished task was retained") }
    if _, ok := m.tasks["0204"]; !ok { t.Fatal("newest finished task was removed") }
    if _, ok := m.tasks["active"]; !ok { t.Fatal("active task was removed") }
}

func TestShutdownWaitsForWorkersAndRejectsNewTransfers(t *testing.T) {
    m := testManager()
    m.mu.Lock()
    m.workers.Add(1)
    m.mu.Unlock()
    finished := make(chan error, 1)
    go func() { finished <- m.Shutdown(context.Background()) }()

    deadline := time.Now().Add(2 * time.Second)
    for {
        m.mu.Lock()
        closed := m.closed
        m.mu.Unlock()
        if closed { break }
        if time.Now().After(deadline) {
            m.workers.Done()
            t.Fatal("shutdown never began")
        }
        time.Sleep(time.Millisecond)
    }
    select {
    case err := <-finished:
        t.Fatalf("shutdown returned while a worker was active: %v", err)
    default:
    }
    m.workers.Done()
    select {
    case err := <-finished:
        if err != nil { t.Fatal(err) }
    case <-time.After(2 * time.Second):
        t.Fatal("shutdown did not wait for worker completion")
    }

    ref := domain.ConnectionRef{SessionID: "server"}
    if _, err := m.Start(ref, "upload", "/source", "/destination", false); err == nil {
        t.Fatal("closed manager accepted a new transfer")
    }
}

func TestShutdownRespectsDeadline(t *testing.T) {
    m := testManager()
    m.mu.Lock()
    m.workers.Add(1)
    m.mu.Unlock()
    ctx, cancel := context.WithCancel(context.Background())
    cancel()
    if err := m.Shutdown(ctx); err != context.Canceled {
        t.Fatalf("expected context cancellation, got %v", err)
    }
    m.workers.Done()
}
