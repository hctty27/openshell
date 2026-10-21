package sshclient

import (
	"context"
	"errors"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
	"golang.org/x/crypto/ssh"
	"io"
	"strings"
	"sync"
	"time"
)

type outputBudget struct {
	mu             sync.Mutex
	left           int
	truncated      bool
	stdout, stderr strings.Builder
}
type boundedOutput struct {
	budget *outputBudget
	stderr bool
}

func (w boundedOutput) Write(p []byte) (int, error) {
	b := w.budget
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	take := min(n, b.left)
	if w.stderr {
		b.stderr.Write(p[:take])
	} else {
		b.stdout.Write(p[:take])
	}
	b.left -= take
	if take < n {
		b.truncated = true
	}
	return n, nil
}
func QuoteShell(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
func cancelledResult(ctx context.Context, start time.Time) domain.CommandResult {
	reason := "cancelled"
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		reason = "timed_out"
	}
	return domain.CommandResult{Status: "unknown", Reason: reason, ReasonCode: reason, DurationMillis: time.Since(start).Milliseconds()}
}
func (m *Manager) Run(ctx context.Context, ref domain.ConnectionRef, command, cwd string, timeout time.Duration) (domain.CommandResult, error) {
	start := time.Now()
	if !strings.HasPrefix(cwd, "/") || strings.ContainsRune(cwd, 0) || strings.TrimSpace(command) == "" || strings.ContainsRune(command, 0) {
		return domain.CommandResult{}, apperror.New("invalidCommandOrAbsoluteWorkingDirectory", nil)
	}
	if timeout <= 0 || timeout > 10*time.Minute {
		return domain.CommandResult{}, apperror.New("invalidCommandTimeout", nil)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	type opened struct {
		session *ssh.Session
		err     error
	}
	opening := make(chan opened, 1)
	go func() { s, e := m.OpenSession(ref); opening <- opened{s, e} }()
	var s *ssh.Session
	select {
	case v := <-opening:
		if v.err != nil {
			return domain.CommandResult{Status: "unknown", Reason: "channel_failed", ReasonCode: "channel_failed"}, v.err
		}
		s = v.session
	case <-ctx.Done():
		m.Disconnect(ref)
		go func() {
			v := <-opening
			if v.session != nil {
				v.session.Close()
			}
		}()
		return cancelledResult(ctx, start), nil
	}
	defer s.Close()
	budget := &outputBudget{left: 262144}
	s.Stdout = boundedOutput{budget: budget}
	s.Stderr = boundedOutput{budget: budget, stderr: true}
	s.Stdin = strings.NewReader("")
	starting := make(chan error, 1)
	go func() { starting <- s.Start("cd " + QuoteShell(cwd) + " || exit\n" + command) }()
	select {
	case e := <-starting:
		if e != nil {
			return domain.CommandResult{Status: "unknown", Reason: "start_failed", ReasonCode: "start_failed", DurationMillis: time.Since(start).Milliseconds()}, e
		}
	case <-ctx.Done():
		m.Disconnect(ref)
		return cancelledResult(ctx, start), nil
	}
	done := make(chan error, 1)
	go func() { done <- s.Wait() }()
	result := domain.CommandResult{}
	select {
	case e := <-done:
		if e == nil {
			code := 0
			result.Status = "completed"
			result.ExitCode = &code
		} else {
			var exit *ssh.ExitError
			if errors.As(e, &exit) {
				code := exit.ExitStatus()
				result.Status = "failed"
				result.ExitCode = &code
			} else {
				result.Status = "unknown"
				result.Reason = "connection_lost"
				result.ReasonCode = "connection_lost"
			}
		}
	case <-ctx.Done():
		result = cancelledResult(ctx, start)
		go func() { s.Signal(ssh.SIGTERM); s.Close() }()
		select {
		case <-done:
		case <-time.After(250 * time.Millisecond):
			m.Disconnect(ref)
		}
	}
	budget.mu.Lock()
	result.Stdout = strings.ToValidUTF8(budget.stdout.String(), "�")
	result.Stderr = strings.ToValidUTF8(budget.stderr.String(), "�")
	result.Truncated = budget.truncated
	budget.mu.Unlock()
	result.DurationMillis = time.Since(start).Milliseconds()
	return result, nil
}

var _ io.Writer = boundedOutput{}
