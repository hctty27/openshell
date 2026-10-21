package tasks

import (
	"context"
	"github.com/hctty27/openshell/internal/domain"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestConfirmExactlyOnce(t *testing.T) {
	var count atomic.Int32
	c := NewCoordinator(func(ctx context.Context, r domain.ConnectionRef, cmd, cwd string, d time.Duration) (domain.CommandResult, error) {
		count.Add(1)
		time.Sleep(time.Millisecond * 5)
		return domain.CommandResult{Status: "completed"}, nil
	}, func(domain.ConnectionRef) bool { return true })
	p, e := c.Propose(domain.ConnectionRef{TabID: "a", Generation: 1}, "pwd", "check", "/tmp", 60)
	if e != nil {
		t.Fatal(e)
	}
	if count.Load() != 0 {
		t.Fatal("executed before confirmation")
	}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); c.Confirm(context.Background(), p.ID) }()
	}
	wg.Wait()
	if count.Load() != 1 {
		t.Fatal(count.Load())
	}
}
func TestReconnectInvalidatesProposal(t *testing.T) {
	ref := domain.ConnectionRef{TabID: "a", Generation: 1}
	c := NewCoordinator(func(context.Context, domain.ConnectionRef, string, string, time.Duration) (domain.CommandResult, error) {
		t.Fatal("must not execute")
		return domain.CommandResult{}, nil
	}, func(domain.ConnectionRef) bool { return false })
	p, _ := c.Propose(ref, "pwd", "check", "/tmp", 60)
	if _, e := c.Confirm(context.Background(), p.ID); e == nil {
		t.Fatal("accepted stale proposal")
	}
}
func TestTabSwitchKeepsTarget(t *testing.T) {
	a := domain.ConnectionRef{TabID: "a", Generation: 1}
	c := NewCoordinator(func(ctx context.Context, r domain.ConnectionRef, cmd, cwd string, d time.Duration) (domain.CommandResult, error) {
		if r != a {
			t.Fatal("wrong target")
		}
		return domain.CommandResult{Status: "completed"}, nil
	}, func(domain.ConnectionRef) bool { return true })
	p, _ := c.Propose(a, "pwd", "check", "/tmp", 60)
	if _, e := c.Confirm(context.Background(), p.ID); e != nil {
		t.Fatal(e)
	}
}
func TestCloseDuringConfirm(t *testing.T) {
	a := domain.ConnectionRef{TabID: "a", Generation: 1}
	started := make(chan struct{})
	c := NewCoordinator(func(ctx context.Context, r domain.ConnectionRef, cmd, cwd string, d time.Duration) (domain.CommandResult, error) {
		close(started)
		<-ctx.Done()
		return domain.CommandResult{Status: "unknown", Reason: "cancelled"}, nil
	}, func(domain.ConnectionRef) bool { return true })
	p, _ := c.Propose(a, "sleep 10", "wait", "/tmp", 60)
	done := make(chan struct{})
	go func() { c.Confirm(context.Background(), p.ID); close(done) }()
	<-started
	c.Invalidate(a)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("did not cancel")
	}
}
func TestUnknownToolNeverExecutes(t *testing.T) {
	c := NewCoordinator(nil, nil)
	if _, e := c.Propose(domain.ConnectionRef{}, "pwd", "check", "relative", 60); e == nil {
		t.Fatal("accepted relative cwd")
	}
	if _, e := ParseTool("evil", `{"command":"pwd","purpose":"x","cwd":"/"}`); e == nil {
		t.Fatal("accepted unknown tool")
	}
	if _, e := ParseTool("propose_command", `{"command":"pwd","purpose":"x","cwd":"/","host":"other"}`); e == nil {
		t.Fatal("accepted unknown target")
	}
}
func TestInvalidRevisionKeepsOriginalConfirmable(t *testing.T) {
	c := NewCoordinator(func(context.Context, domain.ConnectionRef, string, string, time.Duration) (domain.CommandResult, error) {
		return domain.CommandResult{Status: "completed"}, nil
	}, func(domain.ConnectionRef) bool { return true })
	p, _ := c.Propose(domain.ConnectionRef{TabID: "a"}, "pwd", "check", "/tmp", 60)
	if _, e := c.Revise(p.ID, "pwd", "relative", 60); e == nil {
		t.Fatal("invalid revision accepted")
	}
	if _, e := c.Confirm(context.Background(), p.ID); e != nil {
		t.Fatal(e)
	}
}
func TestCancellationReportsAtomicPriorState(t *testing.T) {
	started := make(chan struct{})
	c := NewCoordinator(func(ctx context.Context, r domain.ConnectionRef, cmd, cwd string, d time.Duration) (domain.CommandResult, error) {
		close(started)
		<-ctx.Done()
		return domain.CommandResult{Status: "unknown"}, nil
	}, func(domain.ConnectionRef) bool { return true })
	p, _ := c.Propose(domain.ConnectionRef{TabID: "a"}, "pwd", "check", "/tmp", 60)
	done := make(chan struct{})
	go func() { c.Confirm(context.Background(), p.ID); close(done) }()
	<-started
	rejected, e := c.CancelWithState(p.ID)
	if e != nil || rejected {
		t.Fatal("running execution reported never started", rejected, e)
	}
	<-done
	p, _ = c.Propose(domain.ConnectionRef{TabID: "a"}, "pwd", "check", "/tmp", 60)
	rejected, e = c.CancelWithState(p.ID)
	if e != nil || !rejected {
		t.Fatal("pending rejection not reported", rejected, e)
	}
}

func TestRemoteCommandsRejectRedundantSSHLogin(t *testing.T) {
	for _, command := range []string{`ssh root@192.0.2.10 "ps -eo pid,ppid,etime,args | grep '[j]ava'"`, `/usr/bin/ssh -p 22 root@server ps`, `'ssh' user@host ps`} {
		_, err := ParseTool("propose_command", `{"command":`+strconv.Quote(command)+`,"purpose":"查询 Java 进程","cwd":"/root"}`)
		if err == nil {
			t.Fatalf("redundant remote login accepted: %s", command)
		}
	}
	for _, command := range []string{`ps -eo pid,ppid,etime,args | grep '[j]ava'`, `printf 'ssh user@host'`, `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`} {
		if _, err := ParseTool("propose_command", `{"command":`+strconv.Quote(command)+`,"purpose":"检查","cwd":"/root"}`); err != nil {
			t.Fatal(err)
		}
	}
}
