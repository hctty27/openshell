package sshclient

import (
	"context"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/hctty27/openshell/internal/domain"
	"golang.org/x/crypto/ssh"
)

// AIExecutionMode decides the command transport before sending an AI command.
// A failed capability probe is never retried as the same user command.
func (m *Manager) AIExecutionMode(ctx context.Context, ref domain.ConnectionRef) (string, error) {
	m.mu.Lock()
	c := m.connections[ref.TabID]
	if c == nil || c.ref != ref {
		m.mu.Unlock()
		return "", errors.New("SSH 会话已断开或发生变化，请重新连接")
	}
	if isJumpServerVersion(c.serverVersion) || c.readiness.isJumpServer() {
		m.mu.Unlock()
		return "terminal", nil
	}
	if c.aiExecProbed {
		supported := c.aiExecSupported
		m.mu.Unlock()
		if supported { return "independent", nil }
		return "terminal", nil
	}
	client := c.client
	m.mu.Unlock()

	// This harmless, bounded request confirms exec works on this transport.
	// It never contains the user's command and cannot modify the remote host.
	supported := probeAIExec(ctx, client)
	if err := ctx.Err(); err != nil { return "", err }

	m.mu.Lock()
	active := m.connections[ref.TabID] == c && c.ref == ref
	if active {
		c.aiExecProbed = true
		c.aiExecSupported = supported
	}
	m.mu.Unlock()
	if !active { return "", errors.New("SSH 会话已断开或发生变化，请重新连接") }
	// A slow server may show the KoKo menu while the probe is in flight.
	if c.readiness.isJumpServer() { return "terminal", nil }
	if supported { return "independent", nil }
	return "terminal", nil
}

func isJumpServerVersion(version string) bool {
	return strings.Contains(strings.ToLower(version), "jumpserver")
}

type aiProbeOutput struct { data []byte }
func (w *aiProbeOutput) Write(p []byte) (int, error) {
	if remaining := 128 - len(w.data); remaining > 0 {
		n := len(p)
		if n > remaining { n = remaining }
		w.data = append(w.data, p[:n]...)
	}
	return len(p), nil
}

func probeAIExec(ctx context.Context, client interface{ NewSession() (*ssh.Session, error) }) bool {
	if client == nil { return false }
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	result := make(chan bool, 1)

	go func() {
		// NewSession itself may block if the SSH peer never replies to the
		// channel-open request. Keep the caller bounded without closing the
		// shared SSH transport or touching the user's visible terminal.
		session, err := client.NewSession()
		if err != nil { result <- false; return }
		defer session.Close()
		if probeCtx.Err() != nil { result <- false; return }

		token := "OPEN_SHELL_AI_EXEC_" + strings.ReplaceAll(domain.NewID(), "-", "")
		output := &aiProbeOutput{}
		session.Stdout = output
		session.Stderr = io.Discard
		done := make(chan error, 1)
		go func() { done <- session.Run("printf '%s' '" + token + "'") }()
		select {
		case err := <-done:
			result <- err == nil && string(output.data) == token
		case <-probeCtx.Done():
			_ = session.Close()
			result <- false
		}
	}()

	select {
	case supported := <-result:
		return supported
	case <-probeCtx.Done():
		return false
	}
}
