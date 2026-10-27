package tasks

import (
	"context"
	"github.com/hctty27/openshell/internal/domain"
	"sync/atomic"
	"testing"
)

func TestAutomaticReadOnlyPolicy(t *testing.T) {
	for _, command := range []string{"pwd", "ps -ef | grep '[j]ava'", "df -h && free -m", "cat '/var/log/app.log'", "systemctl --no-pager status app", "journalctl -u app -n 50 --no-pager"} {
		if !IsInspectionCommand(command) {
			t.Errorf("inspection rejected: %s", command)
		}
	}
	for _, command := range []string{"rm /tmp/file", "systemctl restart app", "journalctl --vacuum-time=1d", "cat /etc/passwd > /tmp/out", "echo $(touch /tmp/file)", "ps; rm x", "ps &", "ps >x", "find / -delete", "awk 'BEGIN{system(\"id\")}'", "sudo ps -ef", "/tmp/ps", "ls `touch x`", "FOO=x ps", "ps | sh", "cat <(id)", "systemctl -H other status app", "hostname other", "ss -K", "ss --diag=/tmp/out"} {
		if IsInspectionCommand(command) {
			t.Errorf("unsafe command accepted: %s", command)
		}
	}
}

func TestAutomaticLimitAndExplicitExtension(t *testing.T) {
	var executed atomic.Int32
	ref := domain.ConnectionRef{TabID: "tab", Generation: 1}
	r := NewAutomaticRunner()
	callbacks := AutoCallbacks{
		Valid: func(domain.ConnectionRef) bool { return true },
		Model: func(context.Context, bool) (AutoReply, error) {
			return AutoReply{Proposal: &domain.Proposal{ID: domain.NewID(), Ref: ref, Command: "pwd", Cwd: "/"}}, nil
		},
		Execute: func(context.Context, domain.Proposal) (domain.CommandResult, error) {
			executed.Add(1)
			return domain.CommandResult{Status: "completed"}, nil
		},
	}
	if err := r.Start(context.Background(), "task", ref, 1, true, callbacks); err != nil {
		t.Fatal(err)
	}
	state, err := r.Run("task", "", false)
	if err != nil || state.Status != "limit" || executed.Load() != 1 {
		t.Fatal(state, err, executed.Load())
	}
	state, err = r.Run("task", "", true)
	// A repeated proposal still needs explicit approval after extending the round.
	if err != nil || state.Status != "awaiting_confirmation" || executed.Load() != 1 {
		t.Fatal(state, err, executed.Load())
	}
	state, err = r.Run("task", state.Proposal.ID, false)
	if err != nil || state.Status != "limit" || executed.Load() != 2 {
		t.Fatal(state, err, executed.Load())
	}
}

func TestAutomaticModificationWaitsForExactApproval(t *testing.T) {
	ref := domain.ConnectionRef{TabID: "tab", Generation: 1}
	executed := 0
	models := 0
	r := NewAutomaticRunner()
	r.Start(context.Background(), "task", ref, 10, false, AutoCallbacks{
		Valid: func(domain.ConnectionRef) bool { return true },
		Model: func(context.Context, bool) (AutoReply, error) {
			models++
			if models > 1 {
				return AutoReply{Text: "done"}, nil
			}
			return AutoReply{Proposal: &domain.Proposal{ID: "proposal", Ref: ref, Command: "systemctl restart app", Cwd: "/"}}, nil
		},
		Execute: func(context.Context, domain.Proposal) (domain.CommandResult, error) {
			executed++
			return domain.CommandResult{Status: "completed"}, nil
		},
	})
	s, e := r.Run("task", "", false)
	if e != nil || s.Status != "awaiting_confirmation" || executed != 0 {
		t.Fatal(s, e)
	}
	if _, e = r.Run("task", "wrong", false); e == nil {
		t.Fatal("accepted mismatched approval")
	}
	s, e = r.Run("task", "proposal", false)
	if e != nil || s.Status != "completed" || executed != 1 {
		t.Fatal(s, e, executed)
	}
}

func TestAutomaticStopBeforeStartAndTargetChange(t *testing.T) {
	r := NewAutomaticRunner()
	r.Stop("early")
	ref := domain.ConnectionRef{TabID: "tab", Generation: 1}
	if e := r.Start(context.Background(), "early", ref, 10, false, AutoCallbacks{}); e == nil {
		t.Fatal("cancelled task started")
	}
	r.Start(context.Background(), "changed", ref, 10, false, AutoCallbacks{Valid: func(domain.ConnectionRef) bool { return false }, Model: func(context.Context, bool) (AutoReply, error) {
		t.Fatal("model called after connection changed")
		return AutoReply{}, nil
	}})
	s, _ := r.Run("changed", "", false)
	if s.Status != "stopped" {
		t.Fatal(s)
	}
}

func TestAutomaticUnknownOutcomeStopsWithoutNextModel(t *testing.T) {
	r := NewAutomaticRunner()
	ref := domain.ConnectionRef{TabID: "tab", Generation: 1}
	models := 0
	r.Start(context.Background(), "task", ref, 10, true, AutoCallbacks{
		Valid: func(domain.ConnectionRef) bool { return true },
		Model: func(context.Context, bool) (AutoReply, error) {
			models++
			return AutoReply{Proposal: &domain.Proposal{ID: "p", Ref: ref, Command: "pwd", Cwd: "/"}}, nil
		},
		Execute: func(context.Context, domain.Proposal) (domain.CommandResult, error) {
			return domain.CommandResult{Status: "unknown", Reason: "timed_out"}, nil
		},
	})
	s, _ := r.Run("task", "", false)
	if s.Status != "stopped" || models != 1 {
		t.Fatal(s, models)
	}
}

func TestAutomaticStopDuringModelDiscardsLateProposal(t *testing.T) {
	r := NewAutomaticRunner()
	ref := domain.ConnectionRef{TabID: "tab", Generation: 1}
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan AutoSnapshot, 1)
	var cancelled, executed atomic.Int32
	r.Start(context.Background(), "task", ref, 10, false, AutoCallbacks{
		Valid: func(domain.ConnectionRef) bool { return true },
		Model: func(context.Context, bool) (AutoReply, error) {
			close(entered)
			<-release
			return AutoReply{Proposal: &domain.Proposal{ID: "late", Ref: ref, Command: "pwd"}}, nil
		},
		CancelProposal: func(string) { cancelled.Add(1) },
		Execute: func(context.Context, domain.Proposal) (domain.CommandResult, error) {
			executed.Add(1)
			return domain.CommandResult{Status: "completed"}, nil
		},
	})
	go func() { s, _ := r.Run("task", "", false); done <- s }()
	<-entered
	if _, err := r.Run("task", "", false); err == nil {
		t.Fatal("concurrent run accepted")
	}
	r.Stop("task")
	close(release)
	s := <-done
	if s.Status != "stopped" || executed.Load() != 0 || cancelled.Load() != 1 || r.Active("tab") {
		t.Fatal(s, executed.Load(), cancelled.Load())
	}
}

func TestAutomaticStopDuringExecutionPreventsContinuation(t *testing.T) {
	r := NewAutomaticRunner()
	ref := domain.ConnectionRef{TabID: "tab", Generation: 1}
	entered, done := make(chan struct{}), make(chan AutoSnapshot, 1)
	var models atomic.Int32
	r.Start(context.Background(), "task", ref, 10, false, AutoCallbacks{
		Valid: func(domain.ConnectionRef) bool { return true },
		Model: func(context.Context, bool) (AutoReply, error) {
			models.Add(1)
			return AutoReply{Proposal: &domain.Proposal{ID: "p", Ref: ref, Command: "pwd"}}, nil
		},
		Execute: func(ctx context.Context, _ domain.Proposal) (domain.CommandResult, error) {
			close(entered)
			<-ctx.Done()
			return domain.CommandResult{Status: "cancelled"}, ctx.Err()
		},
	})
	go func() { s, _ := r.Run("task", "", false); done <- s }()
	<-entered
	r.Invalidate(ref)
	s := <-done
	if s.Status != "stopped" || models.Load() != 1 || s.Steps != 1 {
		t.Fatal(s, models.Load())
	}
}

func TestAutomaticHighRiskRequiresApprovalEvenWhenChangesEnabled(t *testing.T) {
    ref := domain.ConnectionRef{TabID: "host", Generation: 1}
    r := NewAutomaticRunner()
    var executions int
    var models int
    if err := r.Start(context.Background(), "high-risk-task", ref, 10, true, AutoCallbacks{
        Valid: func(domain.ConnectionRef) bool { return true },
        Model: func(context.Context, bool) (AutoReply, error) {
            models++
            if models != 1 { return AutoReply{Text:"done"}, nil }
            return AutoReply{Proposal: &domain.Proposal{ID:"restart", Ref:ref, Command:"supervisorctl stop all", Cwd:"/"}}, nil
        },
        Execute: func(context.Context, domain.Proposal) (domain.CommandResult, error) {
            executions++
            return domain.CommandResult{Status:"completed"}, nil
        },
    }); err != nil { t.Fatal(err) }
    snapshot, err := r.Run("high-risk-task", "", false)
    if err != nil || snapshot.Status != "awaiting_confirmation" || snapshot.ReasonCode != "criticalChangeConfirmation" || executions != 0 {
        t.Fatalf("unsafe automatic action executed without confirmation: %+v %v", snapshot, err)
    }
    snapshot, err = r.Run("high-risk-task", "restart", false)
    if err != nil || snapshot.Status != "completed" || executions != 1 {
        t.Fatalf("explicit approval did not authorize exactly one high-risk change: %+v %v", snapshot, err)
    }
}

func TestAutomaticRoutineChangesRunWithoutReviewWhenEnabled(t *testing.T) {
    ref := domain.ConnectionRef{TabID: "tab", Generation: 1}
    r := NewAutomaticRunner()
    models, executed := 0, 0
    if err := r.Start(context.Background(), "routine", ref, 10, true, AutoCallbacks{
        Valid: func(domain.ConnectionRef) bool { return true },
        Model: func(context.Context, bool) (AutoReply, error) {
            models++
            if models == 1 {
                return AutoReply{Proposal: &domain.Proposal{
                    ID: "routine-proposal", Ref: ref, Command: "systemctl restart myapp", Cwd: "/",
                }}, nil
            }
            return AutoReply{Text: "done"}, nil
        },
        Execute: func(context.Context, domain.Proposal) (domain.CommandResult, error) {
            executed++
            return domain.CommandResult{Status: "completed"}, nil
        },
    }); err != nil { t.Fatal(err) }
    snapshot, err := r.Run("routine", "", false)
    if err != nil || snapshot.Status != "completed" || executed != 1 {
        t.Fatalf("routine change did not run automatically: %+v, %v", snapshot, err)
    }
}

func TestAutomaticAutoContinueStopsRepeatedInspectionLoop(t *testing.T) {
    ref := domain.ConnectionRef{TabID: "tab", Generation: 1}
    r := NewAutomaticRunner()
    models, executed := 0, 0
    if err := r.Start(context.Background(), "loop", ref, 1, true, AutoCallbacks{
        Valid: func(domain.ConnectionRef) bool { return true },
        Model: func(context.Context, bool) (AutoReply, error) {
            models++
            return AutoReply{Proposal: &domain.Proposal{
                ID: domain.NewID(), Ref: ref, Command: "pwd", Cwd: "/",
            }}, nil
        },
        Execute: func(context.Context, domain.Proposal) (domain.CommandResult, error) {
            executed++
            return domain.CommandResult{Status: "completed"}, nil
        },
    }); err != nil { t.Fatal(err) }
    if err := r.SetAutoContinue("loop", true); err != nil { t.Fatal(err) }
    snapshot, err := r.Run("loop", "", false)
    if err != nil || snapshot.Status != "stopped" ||
        snapshot.ReasonCode != "repeatedInspectionNoProgress" || executed != 3 || models != 4 {
        t.Fatalf("unexpected loop guard behavior: %+v err=%v executed=%d models=%d", snapshot, err, executed, models)
    }
}

func TestAutomaticTotalCapIsEnforcedOnEveryCommand(t *testing.T) {
    ref := domain.ConnectionRef{TabID: "tab", Generation: 1}
    r := NewAutomaticRunner()
    executed := 0
    if err := r.Start(context.Background(), "budget", ref, 90, true, AutoCallbacks{
        Valid: func(domain.ConnectionRef) bool { return true },
        Model: func(context.Context, bool) (AutoReply, error) {
            return AutoReply{Proposal: &domain.Proposal{
                ID: domain.NewID(), Ref: ref, Command: "pwd", Cwd: "/tmp/" + domain.NewID(),
            }}, nil
        },
        Execute: func(context.Context, domain.Proposal) (domain.CommandResult, error) {
            executed++
            return domain.CommandResult{Status: "completed"}, nil
        },
    }); err != nil { t.Fatal(err) }
    if err := r.SetAutoContinue("budget", true); err != nil { t.Fatal(err) }
    snapshot, err := r.Run("budget", "", false)
    if err != nil || snapshot.Status != "limit" || snapshot.Steps != maxUnattendedCommands || executed != maxUnattendedCommands {
        t.Fatalf("unattended cap exceeded: %+v err=%v executions=%d", snapshot, err, executed)
    }
}
