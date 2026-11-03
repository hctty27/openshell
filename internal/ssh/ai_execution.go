package sshclient

import (
	"context"
	"errors"
	"io"

	"golang.org/x/crypto/ssh"
	"strings"
	"time"

	"github.com/hctty27/openshell/internal/domain"
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

	m.mu.Lock()
	active := m.connections[ref.TabID] == c && c.ref == ref
	if active {
		c.aiExecProbed = true
		c.aiExecSupported = supported
	}
	m.mu.Unlock()
	if !active { return "", errors.New("SSH 会话已断开或发生变化，请重新连接") }
	if err := ctx.Err(); err != nil { return "", err }
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
	session, err := client.NewSession()
	if err != nil { return false }
	defer session.Close()

	token := "OPEN_SHELL_AI_EXEC_" + strings.ReplaceAll(domain.NewID(), "-", "")
	output := &aiProbeOutput{}
	session.Stdout = output
	session.Stderr = io.Discard
	done := make(chan error, 1)
	go func() { done <- session.Run("printf '%s' '" + token + "'") }()

	select {
	case err := <-done:
		return err == nil && string(output.data) == token
	case <-probeCtx.Done():
		_ = session.Close()
		return false
	}
}
