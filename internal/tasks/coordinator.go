package tasks

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
	"io"
	"path"
	"strings"
	"sync"
	"time"
)

type RunFunc func(context.Context, domain.ConnectionRef, string, string, time.Duration) (domain.CommandResult, error)
type ToolInput struct {
	TargetID string `json:"target_id,omitempty"`
	Command string `json:"command"`
	Purpose string `json:"purpose"`
	Cwd     string `json:"cwd"`
}

func ParseTool(name, args string) (ToolInput, error) {
	var input ToolInput
	if name != "propose_command" {
		return input, apperror.New("unsupportedToolCallNoCommandWasRun", nil)
	}
	d := json.NewDecoder(bytes.NewBufferString(args))
	d.DisallowUnknownFields()
	if e := d.Decode(&input); e != nil {
		return input, apperror.New("invalidToolArguments", nil)
	}
	if d.Decode(&struct{}{}) != io.EOF {
		return input, apperror.New("toolArgumentsContainTrailingContent", nil)
	}
	if e := validate(input.Command, input.Purpose, input.Cwd); e != nil {
		return input, e
	}
	return input, nil
}
func validate(command, purpose, cwd string) error {
	if strings.TrimSpace(command) == "" || len(command) > 32768 || strings.ContainsRune(command, 0) || strings.TrimSpace(purpose) == "" || len(purpose) > 4096 || !strings.HasPrefix(cwd, "/") || len(cwd) > 4096 || strings.ContainsAny(cwd, "\x00\r\n") {
		return apperror.New("provideACommandPurposeAndValidAbsoluteWorking", nil)
	}
	first := path.Base(strings.Trim(strings.Fields(command)[0], "\"'"))
	switch first {
	case "ssh", "scp", "sftp", "sshpass":
		return apperror.New("alreadyConnectedThroughSshSubmitRawCommandsSuch", nil)
	}
	return nil
}

type entry struct {
	proposal domain.Proposal
	cancel   context.CancelFunc
}
type Coordinator struct {
	mu    sync.Mutex
	items map[string]*entry
	run   RunFunc
	valid func(domain.ConnectionRef) bool
}

func NewCoordinator(run RunFunc, valid func(domain.ConnectionRef) bool) *Coordinator {
	return &Coordinator{items: map[string]*entry{}, run: run, valid: valid}
}
func (c *Coordinator) Propose(ref domain.ConnectionRef, command, purpose, cwd string, seconds int) (domain.Proposal, error) {
	if e := validate(command, purpose, cwd); e != nil {
		return domain.Proposal{}, e
	}
	if seconds == 0 {
		seconds = 60
	}
	if seconds < 1 || seconds > 600 {
		return domain.Proposal{}, apperror.New("timeoutMustBeBetween1And600Seconds", nil)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, item := range c.items {
		if item.proposal.Ref.TabID == ref.TabID && (item.proposal.Status == "running" || item.proposal.Status == "awaiting_confirmation") {
			return domain.Proposal{}, apperror.New("handleThePendingCommandProposalFirst", nil)
		}
	}
	p := domain.Proposal{ID: domain.NewID(), Ref: ref, Command: command, Purpose: purpose, Cwd: cwd, TimeoutSeconds: seconds, Status: "awaiting_confirmation"}
	c.items[p.ID] = &entry{proposal: p}
	return p, nil
}
func (c *Coordinator) Get(id string) (domain.Proposal, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.items[id]
	if e == nil {
		return domain.Proposal{}, apperror.New("proposalNotFound", nil)
	}
	return e.proposal, nil
}
func (c *Coordinator) Confirm(ctx context.Context, id string) (domain.CommandResult, error) {
	c.mu.Lock()
	item := c.items[id]
	if item == nil || item.proposal.Status != "awaiting_confirmation" {
		c.mu.Unlock()
		return domain.CommandResult{}, apperror.New("proposalAlreadyHandledOrExpired", nil)
	}
	if c.valid == nil || !c.valid(item.proposal.Ref) {
		item.proposal.Status = "invalidated"
		c.mu.Unlock()
		return domain.CommandResult{}, apperror.New("targetConnectionChangedGenerateANewProposal", nil)
	}
	ctx, cancel := context.WithCancel(ctx)
	item.cancel = cancel
	item.proposal.Status = "running"
	p := item.proposal
	c.mu.Unlock()
	defer cancel()
	result, e := c.run(ctx, p.Ref, p.Command, p.Cwd, time.Duration(p.TimeoutSeconds)*time.Second)
	c.mu.Lock()
	if result.Status == "" {
		result.Status = "unknown"
	}
	item.proposal.Status = result.Status
	item.cancel = nil
	c.mu.Unlock()
	return result, e
}
func (c *Coordinator) Cancel(id string) error { _, e := c.CancelWithState(id); return e }
func (c *Coordinator) CancelWithState(id string) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	item := c.items[id]
	if item == nil {
		return false, apperror.New("proposalNotFound", nil)
	}
	if item.cancel != nil {
		item.cancel()
		return false, nil
	}
	if item.proposal.Status == "awaiting_confirmation" {
		item.proposal.Status = "cancelled"
		return true, nil
	}
	return false, nil
}
func (c *Coordinator) Invalidate(ref domain.ConnectionRef) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, item := range c.items {
		if item.proposal.Ref == ref {
			if item.cancel != nil {
				item.cancel()
			} else if item.proposal.Status == "awaiting_confirmation" {
				item.proposal.Status = "invalidated"
			}
		}
	}
}
func (c *Coordinator) Forget(tab string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, item := range c.items {
		if item.proposal.Ref.TabID == tab {
			if item.cancel != nil {
				item.cancel()
			}
			delete(c.items, id)
		}
	}
}

func (c *Coordinator) Revise(id, command, cwd string, seconds int) (domain.Proposal, error) {
	if seconds < 1 || seconds > 600 {
		return domain.Proposal{}, apperror.New("timeoutMustBeBetween1And600Seconds", nil)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	item := c.items[id]
	if item == nil || item.proposal.Status != "awaiting_confirmation" {
		return domain.Proposal{}, apperror.New("proposalCannotBeEdited", nil)
	}
	if e := validate(command, item.proposal.Purpose, cwd); e != nil {
		return domain.Proposal{}, e
	}
	item.proposal.Status = "invalidated"
	next := item.proposal
	next.ID = domain.NewID()
	next.Command = command
	next.Cwd = cwd
	next.TimeoutSeconds = seconds
	next.Status = "awaiting_confirmation"
	c.items[next.ID] = &entry{proposal: next}
	return next, nil
}
