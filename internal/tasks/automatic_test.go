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
			if models == 1 {
                return AutoReply{Proposal: &domain.Proposal{ID: "proposal", Ref: ref, Command: "systemctl restart app", Cwd: "/"}}, nil
            }
            if models == 2 {
                return AutoReply{Proposal: &domain.Proposal{ID: "verify", Ref: ref, Command: "systemctl status app", Cwd: "/"}}, nil
            }
            return AutoReply{Text: "done"}, nil
		},
		Execute: func(context.Context, domain.Proposal) (domain.CommandResult, error) {
			executed++
			return domain.CommandResult{Status: "completed", ExitCode: successExitCode()}, nil
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
	if e != nil || s.Status != "completed" || s.VerificationChecks != 1 || executed != 2 {
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
            if models == 1 { return AutoReply{Proposal: &domain.Proposal{ID:"restart", Ref:ref, Command:"supervisorctl stop all", Cwd:"/"}}, nil }
            if models == 2 { return AutoReply{Proposal: &domain.Proposal{ID:"verify", Ref:ref, Command:"supervisorctl status app", Cwd:"/"}}, nil }
            return AutoReply{Text:"done"}, nil
        },
        Execute: func(context.Context, domain.Proposal) (domain.CommandResult, error) {
            executions++
            return domain.CommandResult{Status:"completed", ExitCode:successExitCode()}, nil
        },
    }); err != nil { t.Fatal(err) }
    snapshot, err := r.Run("high-risk-task", "", false)
    if err != nil || snapshot.Status != "awaiting_confirmation" || snapshot.ReasonCode != "criticalChangeConfirmation" || executions != 0 {
        t.Fatalf("unsafe automatic action executed without confirmation: %+v %v", snapshot, err)
    }
    snapshot, err = r.Run("high-risk-task", "restart", false)
    if err != nil || snapshot.Status != "completed" || snapshot.VerificationChecks != 1 || executions != 2 {
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
            if models == 2 {
                return AutoReply{Proposal: &domain.Proposal{ID: "verify", Ref: ref, Command: "systemctl status myapp", Cwd: "/"}}, nil
            }
            return AutoReply{Text: "done"}, nil
        },
        Execute: func(context.Context, domain.Proposal) (domain.CommandResult, error) {
            executed++
            return domain.CommandResult{Status: "completed", ExitCode: successExitCode()}, nil
        },
    }); err != nil { t.Fatal(err) }
    snapshot, err := r.Run("routine", "", false)
    if err != nil || snapshot.Status != "completed" || snapshot.VerificationChecks != 1 || executed != 2 {
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

func TestAutomaticRepeatedInspectionAllowsChangingResults(t *testing.T) {
    ref := domain.ConnectionRef{TabID: "tab", Generation: 1}
    r := NewAutomaticRunner()
    models, executed := 0, 0
    if err := r.Start(context.Background(), "progress", ref, 1, true, AutoCallbacks{
        Valid: func(domain.ConnectionRef) bool { return true },
        Model: func(context.Context, bool) (AutoReply, error) {
            models++
            if models > 4 { return AutoReply{Text: "done"}, nil }
            return AutoReply{Proposal: &domain.Proposal{
                ID: domain.NewID(), Ref: ref, Command: "pwd", Cwd: "/",
            }}, nil
        },
        Execute: func(context.Context, domain.Proposal) (domain.CommandResult, error) {
            executed++
            return domain.CommandResult{Status: "completed", Stdout: string(rune('0' + executed))}, nil
        },
    }); err != nil { t.Fatal(err) }
    if err := r.SetAutoContinue("progress", true); err != nil { t.Fatal(err) }
    snapshot, err := r.Run("progress", "", false)
    if err != nil || snapshot.Status != "completed" || executed != 4 {
        t.Fatalf("changing inspection output should not trigger no-progress guard: %+v %v", snapshot, err)
    }
}

func successExitCode() *int {
    code := 0
    return &code
}

func TestAutomaticChangeRequiresVerification(t *testing.T) {
    ref := domain.ConnectionRef{TabID: "tab", Generation: 1}
    r := NewAutomaticRunner()
    calls, executions := 0, 0
    err := r.Start(context.Background(), "verify", ref, 10, true, AutoCallbacks{
        Valid: func(domain.ConnectionRef) bool { return true },
        Model: func(context.Context, bool) (AutoReply, error) {
            calls++
            if calls == 1 {
                return AutoReply{Proposal: &domain.Proposal{
                    ID: "write", Ref: ref, Command: "systemctl restart myapp", Cwd: "/",
                }}, nil
            }
            return AutoReply{Text: "done"}, nil
        },
        Execute: func(context.Context, domain.Proposal) (domain.CommandResult, error) {
            executions++
            return domain.CommandResult{Status: "completed", ExitCode: successExitCode()}, nil
        },
    })
    if err != nil { t.Fatal(err) }
    snapshot, err := r.Run("verify", "", false)
    if err != nil || snapshot.Status != "stopped" || snapshot.ReasonCode != "verificationRequired" ||
        !snapshot.VerificationPending || executions != 1 {
        t.Fatalf("unverified mutation was accepted: %+v err=%v", snapshot, err)
    }
}

func TestAutomaticDiagnosesFailedWriteAndVerifiesRepair(t *testing.T) {
    ref := domain.ConnectionRef{TabID: "tab", Generation: 1}
    r := NewAutomaticRunner()
    commands := []string{
        "systemctl restart myapp",
        "systemctl status myapp",
        "systemctl start myapp",
        "systemctl status myapp",
    }
    calls, executed := 0, 0
    err := r.Start(context.Background(), "recover", ref, 10, true, AutoCallbacks{
        Valid: func(domain.ConnectionRef) bool { return true },
        Model: func(context.Context, bool) (AutoReply, error) {
            calls++
            if calls <= len(commands) {
                return AutoReply{Proposal: &domain.Proposal{
                    ID: domain.NewID(), Ref: ref, Command: commands[calls-1], Cwd: "/",
                }}, nil
            }
            return AutoReply{Text: "done"}, nil
        },
        Execute: func(_ context.Context, p domain.Proposal) (domain.CommandResult, error) {
            executed++
            if p.Command == "systemctl restart myapp" {
                code := 1
                return domain.CommandResult{Status: "failed", ExitCode: &code, Stderr: "service not responding"}, nil
            }
            return domain.CommandResult{Status: "completed", ExitCode: successExitCode()}, nil
        },
    })
    if err != nil { t.Fatal(err) }
    snapshot, err := r.Run("recover", "", false)
    if err != nil || snapshot.Status != "completed" || snapshot.RecoveryFailures != 1 ||
        snapshot.VerificationChecks != 2 || snapshot.VerificationPending || executed != 4 {
        t.Fatalf("recovery or verification failed: %+v err=%v commands=%d", snapshot, err, executed)
    }
}

func TestAutomaticRepeatedFailuresStop(t *testing.T) {
    ref := domain.ConnectionRef{TabID: "tab", Generation: 1}
    r := NewAutomaticRunner()
    executed := 0
    err := r.Start(context.Background(), "failures", ref, 10, true, AutoCallbacks{
        Valid: func(domain.ConnectionRef) bool { return true },
        Model: func(context.Context, bool) (AutoReply, error) {
            return AutoReply{Proposal: &domain.Proposal{
                ID: domain.NewID(), Ref: ref, Command: "pwd", Cwd: "/tmp/" + domain.NewID(),
            }}, nil
        },
        Execute: func(context.Context, domain.Proposal) (domain.CommandResult, error) {
            executed++
            code := 1
            return domain.CommandResult{Status: "failed", ExitCode: &code}, nil
        },
    })
    if err != nil { t.Fatal(err) }
    snapshot, err := r.Run("failures", "", false)
    if err != nil || snapshot.Status != "stopped" || snapshot.ReasonCode != "recoveryAttemptsExhausted" ||
        snapshot.RecoveryFailures != 3 || executed != 3 {
        t.Fatalf("recovery budget was not respected: %+v err=%v commands=%d", snapshot, err, executed)
    }
}

func TestAutomaticVerificationIsBoundToChangeTarget(t *testing.T) {
    first := domain.ConnectionRef{TabID: "first", Generation: 1}
    second := domain.ConnectionRef{TabID: "second", Generation: 1}
    r := NewAutomaticRunner()
    models, executed, rejected := 0, 0, 0
    err := r.Start(context.Background(), "multi", first, 10, true, AutoCallbacks{
        Valid: func(domain.ConnectionRef) bool { return true },
        Authorized: func(domain.ConnectionRef) bool { return true },
        Model: func(context.Context, bool) (AutoReply, error) {
            models++
            switch models {
            case 1:
                return AutoReply{Proposal: &domain.Proposal{
                    ID: "change", Ref: first, Command: "systemctl restart myapp", Cwd: "/",
                }}, nil
            case 2:
                return AutoReply{Proposal: &domain.Proposal{
                    ID: "wrong", Ref: second, Command: "pwd", Cwd: "/",
                }}, nil
            case 3:
                return AutoReply{Proposal: &domain.Proposal{
                    ID: "correct", Ref: first, Command: "pwd", Cwd: "/",
                }}, nil
            default:
                return AutoReply{Text: "done"}, nil
            }
        },
        CancelProposal: func(string) { rejected++ },
        Execute: func(context.Context, domain.Proposal) (domain.CommandResult, error) {
            executed++
            return domain.CommandResult{Status: "completed", ExitCode: successExitCode()}, nil
        },
    })
    if err != nil { t.Fatal(err) }
    snapshot, err := r.Run("multi", "", false)
    if err != nil || snapshot.Status != "completed" || snapshot.VerificationChecks != 1 ||
        executed != 2 || rejected != 1 {
        t.Fatalf("cross-target verification was accepted: %+v err=%v executed=%d rejected=%d", snapshot, err, executed, rejected)
    }
}

func TestAutomaticUnresolvedFailureIsNotCompletion(t *testing.T) {
    ref := domain.ConnectionRef{TabID: "tab", Generation: 1}
    r := NewAutomaticRunner()
    models := 0
    err := r.Start(context.Background(), "unresolved", ref, 10, true, AutoCallbacks{
        Valid: func(domain.ConnectionRef) bool { return true },
        Model: func(context.Context, bool) (AutoReply, error) {
            models++
            switch models {
            case 1:
                return AutoReply{Proposal: &domain.Proposal{
                    ID: "change", Ref: ref, Command: "systemctl restart myapp", Cwd: "/",
                }}, nil
            case 2:
                return AutoReply{Proposal: &domain.Proposal{
                    ID: "diagnostic", Ref: ref, Command: "pwd", Cwd: "/",
                }}, nil
            default:
                return AutoReply{Text: "all done"}, nil
            }
        },
        Execute: func(_ context.Context, p domain.Proposal) (domain.CommandResult, error) {
            if p.Command == "pwd" {
                return domain.CommandResult{Status: "completed", ExitCode: successExitCode()}, nil
            }
            code := 1
            return domain.CommandResult{Status: "failed", ExitCode: &code}, nil
        },
    })
    if err != nil { t.Fatal(err) }
    snapshot, err := r.Run("unresolved", "", false)
    if err != nil || snapshot.Status != "stopped" || snapshot.ReasonCode != "failedTaskUnresolved" ||
        snapshot.VerificationChecks != 1 || snapshot.RecoveryFailures != 1 {
        t.Fatalf("unresolved failure was marked as success: %+v err=%v", snapshot, err)
    }
}

func TestAutomaticRequiresVerifiedInspectionExitCode(t *testing.T) {
    ref := domain.ConnectionRef{TabID: "tab", Generation: 1}
    r := NewAutomaticRunner()
    calls := 0
    err := r.Start(context.Background(), "missing-exit", ref, 10, true, AutoCallbacks{
        Valid: func(domain.ConnectionRef) bool { return true },
        Model: func(context.Context, bool) (AutoReply, error) {
            calls++
            if calls == 1 {
                return AutoReply{Proposal: &domain.Proposal{
                    ID: "change", Ref: ref, Command: "systemctl restart myapp", Cwd: "/",
                }}, nil
            }
            if calls == 2 {
                return AutoReply{Proposal: &domain.Proposal{
                    ID: "check", Ref: ref, Command: "pwd", Cwd: "/",
                }}, nil
            }
            return AutoReply{Text: "done"}, nil
        },
        Execute: func(_ context.Context, p domain.Proposal) (domain.CommandResult, error) {
            if p.Command == "pwd" {
                return domain.CommandResult{Status: "completed"}, nil
            }
            return domain.CommandResult{Status: "completed", ExitCode: successExitCode()}, nil
        },
    })
    if err != nil { t.Fatal(err) }
    snapshot, err := r.Run("missing-exit", "", false)
    if err != nil || snapshot.Status != "stopped" || snapshot.ReasonCode != "verificationRequired" {
        t.Fatalf("missing inspection exit code counted as proof: %+v err=%v", snapshot, err)
    }
}

func TestAutomaticMarksJournalOnlyAfterSuccessfulInspection(t *testing.T) {
    ref := domain.ConnectionRef{TabID: "tab", Generation: 1}
    r := NewAutomaticRunner()
    models := 0
    checked := []string{}
    err := r.Start(context.Background(), "journal", ref, 10, true, AutoCallbacks{
        Valid: func(domain.ConnectionRef) bool { return true },
        Model: func(context.Context, bool) (AutoReply, error) {
            models++
            if models == 1 {
                return AutoReply{Proposal: &domain.Proposal{
                    ID: "changed", Ref: ref, Command: "systemctl restart myapp", Cwd: "/",
                }}, nil
            }
            if models == 2 {
                return AutoReply{Proposal: &domain.Proposal{
                    ID: "inspected", Ref: ref, Command: "systemctl status myapp", Cwd: "/",
                }}, nil
            }
            return AutoReply{Text: "done"}, nil
        },
        Execute: func(context.Context, domain.Proposal) (domain.CommandResult, error) {
            return domain.CommandResult{Status: "completed", ExitCode: successExitCode()}, nil
        },
        MarkChecked: func(_ context.Context, stepID string) error {
            checked = append(checked, stepID)
            return nil
        },
    })
    if err != nil { t.Fatal(err) }
    snapshot, err := r.Run("journal", "", false)
    if err != nil || snapshot.Status != "completed" || len(checked) != 1 || checked[0] != "changed" {
        t.Fatalf("verification journal callback incorrect: %+v err=%v checked=%v", snapshot, err, checked)
    }
}

func TestAutomaticJournalFailurePreservesPendingVerification(t *testing.T) {
    ref := domain.ConnectionRef{TabID: "tab", Generation: 1}
    r := NewAutomaticRunner()
    models := 0
    err := r.Start(context.Background(), "journal-error", ref, 10, true, AutoCallbacks{
        Valid: func(domain.ConnectionRef) bool { return true },
        Model: func(context.Context, bool) (AutoReply, error) {
            models++
            if models == 1 {
                return AutoReply{Proposal: &domain.Proposal{
                    ID: "changed", Ref: ref, Command: "systemctl restart myapp", Cwd: "/",
                }}, nil
            }
            return AutoReply{Proposal: &domain.Proposal{
                ID: "inspected", Ref: ref, Command: "systemctl status myapp", Cwd: "/",
            }}, nil
        },
        Execute: func(context.Context, domain.Proposal) (domain.CommandResult, error) {
            return domain.CommandResult{Status: "completed", ExitCode: successExitCode()}, nil
        },
        MarkChecked: func(context.Context, string) error {
            return context.DeadlineExceeded
        },
    })
    if err != nil { t.Fatal(err) }
    snapshot, err := r.Run("journal-error", "", false)
    if err != nil || snapshot.Status != "error" || !snapshot.VerificationPending ||
        snapshot.VerificationChecks != 0 {
        t.Fatalf("journal failure falsely cleared verification: %+v err=%v", snapshot, err)
    }
}
