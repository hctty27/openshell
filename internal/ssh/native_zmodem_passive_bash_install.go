package sshclient

import (
	"errors"
	"time"

	"github.com/hctty27/openshell/internal/domain"
)

// This is deliberately a second, explicit opt-in on top of passive ZMODEM.
// The normal GUI and ordinary SSH connection path never install a shell hook.
const nativePassiveBashInstallTimeout = 6 * time.Second

// installNativePassiveBashHook runs only after OpenTerminal has created the
// single SSH PTY. It serializes with all ordinary Manager.Write calls via
// stdinMu. Output events are nonblocking channel notifications from the
// terminal output path; neither channel sends nor receives re-enter SSH output.
func (m *Manager) installNativePassiveBashHook(ref domain.ConnectionRef, expected *connection) {
	expected.stdinMu.Lock()
	defer expected.stdinMu.Unlock()
	// Register cleanup before attempting input takeover: if another task
	// already owns this PTY, do not strand the frontend setup lock.
	sentBootstrap := false
	leaseRestored := false
	leaseAcquired := false
	var inputLease uint64
	success := false
	defer func() {
		if leaseAcquired && !sentBootstrap && !leaseRestored {
			// Nothing was sent to the remote Shell. Release installer-only
			// ownership before publishing the frontend unlocked event.
			_ = expected.inputGate.restore(inputLease)
		}
		active := false
		m.mu.Lock()
		if current := m.connections[ref.TabID]; current == expected && current.ref == ref {
			active = true
			expected.passiveBashHookInstalling = false
			if !success && sentBootstrap {
				// If read -s was entered but never acknowledged, neither
				// manual input nor a future transfer can safely take the PTY.
				expected.nativeTerminalPoisoned = true
				expected.inputGate.blockPassiveInput()
			}
		}
		m.mu.Unlock()
		if !active { return }
		if !success && sentBootstrap {
			m.emit("ssh:native-zmodem-unsupported", map[string]any{
				"ref":ref,
				"error":"Bash Shell 集成未完成验证，当前终端状态不确定；请重新连接 SSH",
			})
		}
		m.emit("ssh:native-zmodem-shell-setup", map[string]any{
			"ref": ref, "active": false, "ready": success,
		})
	}()

	// Prevent both ordinary and direct AI writers from injecting bytes into
	// Bash's hidden nonce prompt, even if they bypass Manager.Write.
	var leaseErr error
	inputLease, leaseErr = expected.inputGate.takeover()
	if leaseErr != nil { return }
	leaseAcquired = true

	alive := func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		return !m.closed && m.connections[ref.TabID] == expected &&
			expected.ref == ref && expected.terminal != nil &&
			!expected.nativeTerminalPoisoned && expected.inputGate != nil &&
			expected.passiveBashHookFilter != nil
	}
	deadline := time.NewTimer(nativePassiveBashInstallTimeout)
	defer deadline.Stop()
	poll := time.NewTicker(20*time.Millisecond)
	defer poll.Stop()
	for {
		if !alive() { return }
		_, ready := expected.readiness.nativeZmodemInputState()
		if ready { break }
		select {
		case <-poll.C:
		case <-deadline.C: return // Never send bootstrap into an unknown prompt.
		}
	}

	token, err := newNativeRemoteBoundaryToken()
	if err != nil { return }
	filter := expected.passiveBashHookFilter
	// Drop old notifications, if a remote program happened to print the
	// public challenge marker before this SSH session started installation.
	for {
		select {case <-filter.events: default: goto drained}
	}
drained:
	if !alive() { return }
	bootstrap := []byte(nativePassiveBashHookBootstrap())
	// Treat even a partial bootstrap Write as unsafe to retry or type over.
	sentBootstrap = true
	if n, err := expected.inputGate.writeNative(inputLease, bootstrap); err != nil || n != len(bootstrap) { return }

	wait := func(want byte) error {
		for {
			if !alive() { return errors.New("SSH generation changed") }
			select {
			case got := <-filter.events:
				if got == want { return nil }
				return errors.New("unexpected Bash integration stage")
			case <-poll.C:
			case <-deadline.C: return errors.New("Bash integration acknowledgment timeout")
			}
		}
	}
	if err = wait(nativeHookEventChallenge); err != nil { return }
	filter.setToken(token)
	// The challenge was seen BEFORE the nonce is sent. The nonce does not
	// occur anywhere in the echoed bootstrap line.
	secret := []byte(token+"\r")
	if n, err := expected.inputGate.writeNative(inputLease, secret); err != nil || n!=len(secret) { return }
	if err = wait(nativeHookEventReady); err != nil { return }
	// Restore only the installer lease. A concurrent passive ZHEX frame
	// would keep passiveBlocked set, and the Manager's poisoned check below
	// prevents this registration from authorizing a verified transfer.
	if err = expected.inputGate.restore(inputLease); err != nil { return }
	leaseRestored = true
	m.mu.Lock()
	if !m.closed && m.connections[ref.TabID] == expected && expected.ref == ref &&
		!expected.nativeTerminalPoisoned && expected.passiveBashHookInstalling {
		expected.passiveBashHookToken = token
		success = true
	}
	m.mu.Unlock()
}
