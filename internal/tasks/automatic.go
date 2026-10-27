package tasks

import (
	"context"
    "crypto/sha256"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
	"github.com/hctty27/openshell/internal/ops"
	"strings"
	"sync"
)

type AutoReply struct {
	Text     string
	Proposal *domain.Proposal
}
type AutoSnapshot struct {
	ReasonCode   string               `json:"reasonCode,omitempty"`
	ReasonParams map[string]any       `json:"reasonParams,omitempty"`
	ID           string               `json:"id"`
	Ref          domain.ConnectionRef `json:"ref"`
	Status       string               `json:"status"`
	Steps        int                  `json:"steps"`
	RoundSteps   int                  `json:"roundSteps"`
	Limit        int                  `json:"limit"`
	AllowChanges bool                 `json:"allowChanges"`
    VerificationPending bool        `json:"verificationPending"`
    VerificationChecks int          `json:"verificationChecks"`
    RecoveryFailures int            `json:"recoveryFailures"`
	Reason       string               `json:"reason"`
	Proposal     *domain.Proposal     `json:"proposal,omitempty"`
}
type AutoEvent struct {
	Kind      string                `json:"kind"`
	State     AutoSnapshot          `json:"state"`
	MessageID string                `json:"messageId,omitempty"`
	Text      string                `json:"text,omitempty"`
	Result    *domain.CommandResult `json:"result,omitempty"`
}
type AutoCallbacks struct {
	Valid          func(domain.ConnectionRef) bool
	Authorized     func(domain.ConnectionRef) bool
	Model          func(context.Context, bool) (AutoReply, error)
	Execute        func(context.Context, domain.Proposal) (domain.CommandResult, error)
	CancelProposal func(string)
	Emit           func(AutoEvent)
}
type automaticTask struct {
	mu            sync.Mutex
	state         AutoSnapshot
	callbacks     AutoCallbacks
	ctx           context.Context
	cancel        context.CancelFunc
	busy, started bool
	messageID     string
	seen          map[string]int
    lastResults   map[string][32]byte
	autoContinue  bool
    verificationRef domain.ConnectionRef
    verificationViolations int
    failedMutation bool
    unresolvedFailure bool
}
type AutomaticRunner struct {
	mu        sync.Mutex
	tasks     map[string]*automaticTask
	cancelled map[string]bool
}

func NewAutomaticRunner() *AutomaticRunner {
	return &AutomaticRunner{tasks: map[string]*automaticTask{}, cancelled: map[string]bool{}}
}
func (r *AutomaticRunner) Start(parent context.Context, id string, ref domain.ConnectionRef, limit int, allowChanges bool, cb AutoCallbacks) error {
	if id == "" || len(id) > 128 || limit < 1 || limit > 100 {
		return apperror.New("invalidAutomaticTaskOrCommandLimit1100", nil)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cancelled[id] {
		return apperror.New("taskStopped", nil)
	}
	if r.tasks[id] != nil {
		return apperror.New("taskAlreadyExists", nil)
	}
	for key, t := range r.tasks {
		t.mu.Lock()
		active := !autoTerminal(t.state.Status)
		sameTab := t.state.Ref.TabID == ref.TabID
		t.mu.Unlock()
		if sameTab && active {
			return apperror.New("thisTabAlreadyHasAnAutomaticTask", nil)
		}
		if sameTab && !active {
			delete(r.tasks, key)
		}
	}
	ctx, cancel := context.WithCancel(parent)
	r.tasks[id] = &automaticTask{state: AutoSnapshot{ID: id, Ref: ref, Status: "ready", Limit: limit, AllowChanges: allowChanges}, callbacks: cb, ctx: ctx, cancel: cancel, seen: map[string]int{}, lastResults: map[string][32]byte{}}
	return nil
}
// SetAutoContinue enables bounded unattended rounds for newly started tasks.
func (r *AutomaticRunner) SetAutoContinue(id string, enabled bool) error {
    t := r.get(id)
    if t == nil {
        return apperror.New("automaticTaskNotFound", nil)
    }
    t.mu.Lock()
    defer t.mu.Unlock()
    if t.busy || t.state.Status != "ready" {
        return apperror.New("taskIsRunningOrHasAlreadyEnded", nil)
    }
    t.autoContinue = enabled
    return nil
}

const maxUnattendedCommands = 200
const maxRecoveryFailures = 3

func autoTerminal(status string) bool {
	return status == "completed" || status == "stopped" || status == "error"
}
func (r *AutomaticRunner) get(id string) *automaticTask {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.tasks[id]
}
func (t *automaticTask) snapshot() AutoSnapshot { t.mu.Lock(); defer t.mu.Unlock(); return t.state }
func (t *automaticTask) emit(kind, text string, result *domain.CommandResult) {
	t.mu.Lock()
	event := AutoEvent{Kind: kind, State: t.state, MessageID: t.messageID, Text: text, Result: result}
	t.mu.Unlock()
	if t.callbacks.Emit != nil {
		t.callbacks.Emit(event)
	}
}
func (t *automaticTask) finish(status, reason string) AutoSnapshot {
	t.mu.Lock()
	if t.state.Status != "stopped" {
		t.state.Status = status
		t.state.Reason = reason
		if fallback, ok := automaticReasons[reason]; ok {
			t.state.Reason = fallback
		}
		t.state.ReasonCode = reason
		if strings.HasPrefix(reason, apperror.Prefix) {
			t.state.ReasonCode = ""
		}
	}
	state := t.state
	t.mu.Unlock()
	if autoTerminal(state.Status) {
		t.cancel()
	}
	t.emit("state", "", nil)
	return state
}
func (t *automaticTask) live() bool {
	return t.ctx.Err() == nil && t.callbacks.Valid != nil && t.callbacks.Valid(t.state.Ref)
}
func (r *AutomaticRunner) Active(tabID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, t := range r.tasks {
		s := t.snapshot()
		if s.Ref.TabID == tabID && !autoTerminal(s.Status) {
			return true
		}
	}
	return false
}
func (r *AutomaticRunner) Stop(id string) {
	r.mu.Lock()
	t := r.tasks[id]
	if t == nil {
		if len(r.cancelled) >= 100 {
			for key := range r.cancelled {
				delete(r.cancelled, key)
				break
			}
		}
		r.cancelled[id] = true
	}
	r.mu.Unlock()
	if t == nil {
		return
	}
	t.mu.Lock()
	if autoTerminal(t.state.Status) {
		t.mu.Unlock()
		return
	}
	t.state.Status = "stopped"
	t.state.Reason = automaticReasons["taskStopped"]
	t.state.ReasonCode = "taskStopped"
	p := t.state.Proposal
	t.cancel()
	t.mu.Unlock()
	if p != nil && t.callbacks.CancelProposal != nil {
		t.callbacks.CancelProposal(p.ID)
	}
	t.emit("state", "", nil)
}
func (r *AutomaticRunner) Invalidate(ref domain.ConnectionRef) {
	r.mu.Lock()
	var ids []string
	for id, t := range r.tasks {
		if t.snapshot().Ref == ref {
			ids = append(ids, id)
		}
	}
	r.mu.Unlock()
	for _, id := range ids {
		r.Stop(id)
	}
}
func (r *AutomaticRunner) Run(id, approvedID string, extend bool) (AutoSnapshot, error) {
	t := r.get(id)
	if t == nil {
		return AutoSnapshot{}, apperror.New("automaticTaskNotFound", nil)
	}
	t.mu.Lock()
	if t.busy || autoTerminal(t.state.Status) {
		t.mu.Unlock()
		return t.snapshot(), apperror.New("taskIsRunningOrHasAlreadyEnded", nil)
	}
	if extend {
		if t.state.Status != "limit" {
			t.mu.Unlock()
			return t.snapshot(), apperror.New("taskHasNotReachedItsRoundLimit", nil)
		}
		t.state.RoundSteps = 0
	}
	if approvedID != "" && (t.state.Status != "awaiting_confirmation" || t.state.Proposal == nil || t.state.Proposal.ID != approvedID) {
		t.mu.Unlock()
		return t.snapshot(), apperror.New("confirmedCommandHasChanged", nil)
	}
	t.busy = true
	t.state.Status = "running"
	t.state.Reason = ""
	t.state.ReasonCode = ""
	t.mu.Unlock()
	defer func() { t.mu.Lock(); t.busy = false; t.mu.Unlock() }()
	t.emit("state", "", nil)
	for {
		if !t.live() {
			r.Stop(id)
			return t.snapshot(), nil
		}
		s := t.snapshot()
		if s.Proposal == nil {
			t.mu.Lock()
			first := !t.started
			t.started = true
			t.messageID = domain.NewID()
			t.mu.Unlock()
			t.emit("thinking", "", nil)
			reply, err := t.callbacks.Model(t.ctx, first)
			if !t.live() {
				if reply.Proposal != nil && t.callbacks.CancelProposal != nil {
					t.callbacks.CancelProposal(reply.Proposal.ID)
				}
				r.Stop(id)
				return t.snapshot(), nil
			}
			if err != nil {
				return t.finish("error", err.Error()), nil
			}
			if reply.Proposal != nil && ((t.callbacks.Authorized != nil && !t.callbacks.Authorized(reply.Proposal.Ref)) || (t.callbacks.Authorized == nil && reply.Proposal.Ref != s.Ref)) {
				return t.finish("error", "taskTargetChanged"), nil
			}
			t.mu.Lock()
			cancelled := t.ctx.Err() != nil
			if !cancelled {
				t.state.Proposal = reply.Proposal
			}
			t.mu.Unlock()
			if cancelled {
				if reply.Proposal != nil && t.callbacks.CancelProposal != nil {
					t.callbacks.CancelProposal(reply.Proposal.ID)
				}
				r.Stop(id)
				return t.snapshot(), nil
			}
			t.emit("reply", reply.Text, nil)
            if reply.Proposal == nil {
                current := t.snapshot()
                if current.VerificationPending {
                    return t.finish("stopped", "verificationRequired"), nil
                }
                t.mu.Lock()
                unresolved := t.unresolvedFailure
                t.mu.Unlock()
                if unresolved {
                    return t.finish("stopped", "failedTaskUnresolved"), nil
                }
                return t.finish("completed", "taskCompleted"), nil
            }
			s = t.snapshot()
		}
		if t.autoContinue && s.Steps >= maxUnattendedCommands {
            return t.finish("limit", "roundLimit"), nil
        }
        if s.RoundSteps >= s.Limit {
            if !t.autoContinue {
                return t.finish("limit", "roundLimit"), nil
            }
            t.mu.Lock()
            t.state.RoundSteps = 0
            t.mu.Unlock()
            t.emit("state", "", nil)
            s = t.snapshot()
        }
		p := *s.Proposal
        // A change must be followed by a successful inspection of the SAME
        // target before additional mutations or a successful completion.
        if s.VerificationPending && (!IsInspectionCommand(p.Command) || p.Ref != t.verificationRef || len(p.Targets) > 0) {
            t.mu.Lock()
            t.state.Proposal = nil
            t.verificationViolations++
            violations := t.verificationViolations
            t.mu.Unlock()
            if t.callbacks.CancelProposal != nil {
                t.callbacks.CancelProposal(p.ID)
            }
            if violations >= 2 {
                return t.finish("stopped", "verificationRequired"), nil
            }
            t.emit("state", "", nil)
            continue
        }
        signature := p.Ref.TabID + "\x00" + p.Cwd + "\x00" + strings.TrimSpace(p.Command)
		reason := ""
		if !s.AllowChanges && !IsInspectionCommand(p.Command) {
            reason = "inspectionConfirmation"
        } else if ops.Analyze(p.Command, IsInspectionCommand(p.Command)).RequiresConfirmation {
            reason = "criticalChangeConfirmation"
        }
		if t.seen[signature] > 0 {
            if !t.autoContinue || !IsInspectionCommand(p.Command) {
                reason = "repeatedCommand"
            } else if t.seen[signature] >= 3 {
                return t.finish("stopped", "repeatedInspectionNoProgress"), nil
            }
        }
		if reason != "" && approvedID != p.ID {
			return t.finish("awaiting_confirmation", reason), nil
		}
		approvedID = ""
		t.mu.Lock()
		if t.ctx.Err() != nil {
			t.mu.Unlock()
			r.Stop(id)
			return t.snapshot(), nil
		}
		t.state.Steps++
		t.state.RoundSteps++
		t.mu.Unlock()
		t.emit("executing", "", nil)
		result, err := t.callbacks.Execute(t.ctx, p)
        t.emit("result", "", &result)
        t.mu.Lock()
        t.state.Proposal = nil
        if t.autoContinue && IsInspectionCommand(p.Command) {
            fingerprint := sha256.Sum256([]byte(result.Status + "\x00" + result.Stdout + "\x00" + result.Stderr))
            if last, exists := t.lastResults[signature]; exists && last == fingerprint {
                t.seen[signature]++
            } else {
                t.seen[signature] = 1
            }
            t.lastResults[signature] = fingerprint
        } else {
            t.seen[signature]++
        }
        t.mu.Unlock()
		if !t.live() {
			r.Stop(id)
			return t.snapshot(), nil
		}
        if err != nil {
            return t.finish("error", err.Error()), nil
        }
        if result.Status == "unknown" || result.Status == "cancelled" || result.Status == "" {
            return t.finish("stopped", "remoteResultUnknown"), nil
        }
        failed := result.Status != "completed" || (result.ExitCode != nil && *result.ExitCode != 0)
        inspected := IsInspectionCommand(p.Command)
        t.mu.Lock()
        if !inspected {
            t.state.VerificationPending = true
            t.verificationRef = p.Ref
            t.verificationViolations = 0
            if failed {
                t.failedMutation = true
            } else {
                t.failedMutation = false
            }
        } else if t.state.VerificationPending && p.Ref == t.verificationRef && !failed && result.ExitCode != nil && *result.ExitCode == 0 {
            t.state.VerificationPending = false
            t.state.VerificationChecks++
            t.verificationViolations = 0
        }
        if failed {
            t.state.RecoveryFailures++
            t.unresolvedFailure = true
        } else if !inspected {
            t.unresolvedFailure = false
        } else if !t.failedMutation && !t.state.VerificationPending {
            t.unresolvedFailure = false
        }
        failures := t.state.RecoveryFailures
        t.mu.Unlock()
        t.emit("state", "", nil)
        if failures >= maxRecoveryFailures {
            return t.finish("stopped", "recoveryAttemptsExhausted"), nil
        }
	}
}

func (r *AutomaticRunner) Forget(tabID string) {
	r.mu.Lock()
	var ids []string
	for id, t := range r.tasks {
		if t.snapshot().Ref.TabID == tabID {
			ids = append(ids, id)
		}
	}
	r.mu.Unlock()
	for _, id := range ids {
		r.Stop(id)
		r.mu.Lock()
		delete(r.tasks, id)
		r.mu.Unlock()
	}
}

var automaticReasons = map[string]string{
	"taskStopped":            "Stopped. No further commands will run.",
	"taskCompleted":          "Task completed",
	"taskTargetChanged":      "Command target does not match the task connection",
	"roundLimit":             "Round limit reached. Continue when ready.",
	"inspectionConfirmation": "Unrecognized inspection command. Confirmation required.",
    "criticalChangeConfirmation": "High-risk change. Review the preflight checklist and confirm explicitly.",
	"repeatedCommand":        "Repeated change. Confirmation required.",
    "repeatedInspectionNoProgress": "Repeated inspection made no progress; automatic task stopped.",
	"remoteResultUnknown":    "Remote result unconfirmed. Automatic task stopped.",
    "verificationRequired": "Modification needs independent read-only verification on the same server.",
    "failedTaskUnresolved": "Command failures remain unresolved; task cannot be marked completed.",
    "recoveryAttemptsExhausted": "Too many failed commands. Automatic recovery stopped.",
}

func (r *AutomaticRunner) CheckOwner(id string, ref domain.ConnectionRef) error {
	t := r.get(id)
	if t == nil || t.snapshot().Ref != ref {
		return apperror.New("memoryNotOwner", nil)
	}
	return nil
}
