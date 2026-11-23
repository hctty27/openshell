package sshclient

import (
	"time"

	"github.com/hctty27/openshell/internal/domain"
)

// This is deliberately a second, explicit opt-in on top of passive ZMODEM.
// The normal GUI and ordinary SSH connection path never install a shell hook.
const nativePassiveBashInstallTimeout = 6 * time.Second

// nativePassiveShellProbeTimeout bounds the wait for the POSIX probe. A
// shell that cannot parse it (or a slow one) simply keeps passive-only mode.
const nativePassiveShellProbeTimeout = 4 * time.Second

// nativeInterrupt aborts a half-run bootstrap: SIGINT ends Bash's hidden
// read -s (or discards the queued line), so the user's next keystrokes can
// never become the nonce.
var nativeInterrupt = []byte{0x03}

// installNativePassiveBashHook runs only after OpenTerminal has created the
// single SSH PTY. It serializes with all ordinary Manager.Write calls via
// stdinMu. Output events are nonblocking channel notifications from the
// terminal output path; neither channel sends nor receives re-enter SSH output.
//
// It first sends a POSIX probe and installs the Bash hook only when the shell
// answers that it is Bash. dash, zsh, sh and fish stay in passive-only mode
// without any error. The echoed probe and bootstrap are hidden from the
// terminal and removed from the Bash history. A failure after the probe
// interrupts the bootstrap with Ctrl-C instead of locking the terminal.
func (m *Manager) installNativePassiveBashHook(ref domain.ConnectionRef, expected *connection) {
	expected.stdinMu.Lock()
	defer expected.stdinMu.Unlock()
	leaseRestored := false
	leaseAcquired := false
	capturing := false
	interrupt := false
	var inputLease uint64
	success := false
	filter := expected.passiveBashHookFilter
	defer func() {
		if interrupt && leaseAcquired && !leaseRestored {
			_, _ = expected.inputGate.writeNative(inputLease, nativeInterrupt)
		}
		if capturing && filter != nil {
			// Show whatever the shell printed, so a failed setup never hides
			// a prompt or an error message.
			_ = filter.endCapture(!success)
		}
		if leaseAcquired && !leaseRestored {
			_ = expected.inputGate.restore(inputLease)
		}
		active := false
		m.mu.Lock()
		if current := m.connections[ref.TabID]; current == expected && current.ref == ref {
			active = true
			expected.passiveBashHookInstalling = false
		}
		m.mu.Unlock()
		if !active { return }
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
	poll := time.NewTicker(20*time.Millisecond)
	defer poll.Stop()
	promptDeadline := time.NewTimer(nativePassiveBashInstallTimeout)
	defer promptDeadline.Stop()
	for {
		if !alive() { return }
		_, ready := expected.readiness.nativeZmodemInputState()
		if ready { break }
		select {
		case <-poll.C:
		case <-promptDeadline.C: return // Never type into an unknown prompt.
		}
	}

	token, err := newNativeRemoteBoundaryToken()
	if err != nil { return }
	// Drop old notifications, if a remote program happened to print a
	// public marker before this SSH session started installation.
	for {
		select {case <-filter.events: default: goto drained}
	}
drained:
	if !alive() { return }
	// wait returns the first hook event, or 0 on timeout or a lost SSH
	// generation.
	wait := func(timeout time.Duration) byte {
		deadline := time.NewTimer(timeout)
		defer deadline.Stop()
		for {
			if !alive() { return 0 }
			select {
			case got := <-filter.events:
				return got
			case <-poll.C:
			case <-deadline.C:
				return 0
			}
		}
	}

	filter.beginCapture()
	capturing = true
	probe := []byte(nativePassiveShellProbe())
	if n, err := expected.inputGate.writeNative(inputLease, probe); err != nil || n != len(probe) { return }
	switch wait(nativePassiveShellProbeTimeout) {
	case nativeHookEventProbeBash:
	case nativeHookEventProbeOther:
		// Not Bash: the filter already dropped the hidden probe line at
		// the answer. Passive ZMODEM keeps working without the hook.
		capturing = false
		return
	default:
		return
	}

	bootstrap := []byte(nativePassiveBashHookBootstrap())
	// From here on a failure may leave Bash inside read -s: interrupt it.
	interrupt = true
	if n, err := expected.inputGate.writeNative(inputLease, bootstrap); err != nil || n != len(bootstrap) { return }
	if wait(nativePassiveBashInstallTimeout) != nativeHookEventChallenge { return }
	filter.setToken(token)
	// The challenge was seen BEFORE the nonce is sent. The nonce does not
	// occur anywhere in the echoed bootstrap line.
	secret := []byte(token+"\r")
	if n, err := expected.inputGate.writeNative(inputLease, secret); err != nil || n!=len(secret) { return }
	if wait(nativePassiveBashInstallTimeout) != nativeHookEventReady { return }
	// READY ended the hidden capture inside the filter.
	capturing = false
	interrupt = false
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
