package sshclient

import (
	"context"
	"os"
	"time"

	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
)

// failNativePassiveGuard is invoked when the stdout scanner detects an
// unclaimable or overflowed ZMODEM stream. It invalidates a pending picker
// immediately, instead of leaving its lease alive until the 2-minute timer.
// The current SSH generation remains quarantined in every failure case.
func (m *Manager) failNativePassiveGuard(ref domain.ConnectionRef, expected *connection) {
	m.mu.Lock()
	c := m.connections[ref.TabID]
	if c == nil || c != expected || c.ref != ref {
		m.mu.Unlock()
		return
	}
	c.nativeTerminalPoisoned = true
	selectionID := uint64(0)
	var guard *nativeOnlyOutputGuard
	if c.nativeZmodemSelection && c.nativeZmodemSelectionPassive {
		selectionID = c.nativeZmodemSelectionID
		c.nativeZmodemSelection = false
		c.nativeZmodemSelectionPassive = false
		guard = c.outputGuard
	}
	m.mu.Unlock()
	if guard != nil { guard.discardCapture() }
	message := apperror.New("zmodemUnclaimedProtocol", nil).Error()
	if selectionID != 0 {
		message = apperror.New("zmodemHandshakeOverflow", nil).Error()
	}
	m.emit("ssh:native-zmodem-unsupported", map[string]any{
		"ref": ref, "error": message,
	})
	if selectionID != 0 {
		// The frontend must mark stdin unsafe before the picker disappears.
		m.emit("ssh:native-zmodem-selection", map[string]any{
			"ref": ref, "selectionId": selectionID, "active": false,
		})
	}
}

// A remote rz/sz process may time out while the user leaves the file
// selection dialog open. Do not buffer indefinitely, and never interpret
// timeout as proof that the remote shell has returned.
const nativePassiveSelectionTimeout = 2 * time.Minute

// expireNativePassiveSelection is scoped to the exact SSH connection and
// monotonically increasing selection ID. A stale timer must never cancel a
// newer selection or an already-admitted Rust transfer.
func (m *Manager) expireNativePassiveSelection(
	ref domain.ConnectionRef, expected *connection, selectionID uint64,
) bool {
	m.mu.Lock()
	c := m.connections[ref.TabID]
	if c == nil || c != expected || c.ref != ref ||
		!c.nativeZmodemSelection || !c.nativeZmodemSelectionPassive ||
		selectionID == 0 || c.nativeZmodemSelectionID != selectionID ||
		c.nativeTerminalTransfer != nil {
		m.mu.Unlock()
		return false
	}
	c.nativeZmodemSelection = false
	c.nativeZmodemSelectionPassive = false
	c.nativeTerminalPoisoned = true
	guard := c.outputGuard
	m.mu.Unlock()
	if guard != nil { guard.discardCapture() }
	// Mark the UI unsafe *before* releasing the picker lease: a delayed
	// frontend event must never briefly reopen terminal stdin.
	m.emit("ssh:native-zmodem-unsupported", map[string]any{
		"ref": ref,
		"error": apperror.New("zmodemSelectionTimeout", nil).Error(),
	})
	m.emit("ssh:native-zmodem-selection", map[string]any{
		"ref": ref, "selectionId": selectionID, "active": false,
	})
	return true
}

// handleNativePassiveFrame runs outside the SSH output Write callback. The
// passive guard already quarantined the terminal and synchronously blocked
// user input before notifying this manager.
func (m *Manager) handleNativePassiveFrame(
	ref domain.ConnectionRef, expected *connection, frame byte,
) {
	m.mu.Lock()
	sidecar := m.nativeAutoSidecar
	m.mu.Unlock()
	status := m.NativeZmodemExperimentalReadiness(ref, sidecar, true)

	m.mu.Lock()
	c := m.connections[ref.TabID]
	valid := !m.closed && c != nil && c == expected && c.ref == ref &&
		c.outputGuard != nil && c.outputGate != nil && c.inputGate != nil &&
		c.nativeTerminalTransfer == nil && !c.nativeZmodemSelection &&
		!c.passiveBashHookInstalling && !c.nativeTerminalPoisoned &&
		!isJumpServerVersion(c.serverVersion) &&
		!c.readiness.isJumpServer() && status.Ready
	if valid {
		candidate, _ := c.readiness.nativeZmodemInputState()
		_, _, buffered := c.outputGuard.pendingCapture()
		valid = candidate && buffered && (frame == 0 || frame == 1)
	}
	if valid {
		c.nativeZmodemSelection = true
		c.nativeZmodemSelectionPassive = true
		c.nativeZmodemPassiveFrame = frame
		c.nativeZmodemSelectionID++
	}
	if c != nil && c == expected && c.ref == ref && !valid {
		c.nativeTerminalPoisoned = true
	}
	var selectionID uint64
	if valid { selectionID = c.nativeZmodemSelectionID }
	var rejectedGuard *nativeOnlyOutputGuard
	if !valid && c != nil && c == expected && c.ref == ref {
		rejectedGuard = c.outputGuard
	}
	m.mu.Unlock()
	if rejectedGuard != nil { rejectedGuard.discardCapture() }

	if valid {
		time.AfterFunc(nativePassiveSelectionTimeout, func() {
			m.expireNativePassiveSelection(ref, expected, selectionID)
		})
	}
	if !valid {
		m.emit("ssh:native-zmodem-unsupported", map[string]any{
			"ref": ref, "error": apperror.New("zmodemUnclaimedProtocol", nil).Error(),
		})
		return
	}
	direction := "download" // remote sz sent ZRQINIT (0)
	if frame == 1 { direction = "upload" } // remote rz sent ZRINIT (1)
	m.emit("ssh:native-zmodem-auto-intent", map[string]any{
		"ref": ref, "selectionId": selectionID, "direction": direction,
		"passive": true, "remotePath": "",
	})
}

// PassiveZmodemSelection returns the confirmed direction for an exact
// selection lease, never trusting a direction supplied only by the UI.
func (m *Manager) PassiveZmodemSelection(ref domain.ConnectionRef, id uint64) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.connections[ref.TabID]
	if c == nil || c.ref != ref || !c.nativeZmodemSelection ||
		!c.nativeZmodemSelectionPassive || id == 0 || c.nativeZmodemSelectionID != id {
		return "", apperror.New("zmodemSelectionExpired", nil)
	}
	if c.nativeZmodemPassiveFrame == 0 { return "download", nil }
	if c.nativeZmodemPassiveFrame == 1 { return "upload", nil }
	return "", apperror.New("zmodemUnknownHandshake", nil)
}


// RunPassiveNativeZmodemTransfer consumes a remote-triggered ZMODEM session.
// It deliberately cannot restore the terminal until a trusted remote shell
// exit boundary is implemented. This method is for the opt-in experiment.
func (m *Manager) RunPassiveNativeZmodemTransfer(
	parent context.Context, ref domain.ConnectionRef, selectionID uint64,
	sidecar, direction, localPath string, progress func(uint64, uint64),
) error {
	_, err := m.RunPassiveNativeZmodemTransferWithResult(parent, ref, selectionID,
		sidecar, direction, localPath, progress)
	return err
}

// RunPassiveNativeZmodemTransferWithResult distinguishes a successful
// ZMODEM protocol from a verified return to the original SSH Shell. The
// latter is exposed to the UI ONLY after Bash hook installation was
// acknowledged before the remote command began, and the exact generation
// still owns the terminal transfer.
func (m *Manager) RunPassiveNativeZmodemTransferWithResult(
	parent context.Context, ref domain.ConnectionRef, selectionID uint64,
	sidecar, direction, localPath string, progress func(uint64, uint64),
) (terminalSafe bool, resultErr error) {
	if parent == nil { return false, apperror.New("zmodemMissingContext", nil) }
	if err := parent.Err(); err != nil { return false, err }
	if sidecar == "" { return false, apperror.New("zmodemSidecarMissing", nil) }
	if info, err := os.Lstat(sidecar); err != nil || !info.Mode().IsRegular() ||
		info.Mode()&os.ModeSymlink != 0 {
		return false, apperror.New("zmodemSidecarInvalid", nil)
	}
	m.mu.Lock()
	c := m.connections[ref.TabID]
	valid := !m.closed && c != nil && c.ref == ref && c.terminal != nil &&
		c.outputGuard != nil && c.outputGate != nil && c.inputGate != nil &&
		c.nativeZmodemSelection && c.nativeZmodemSelectionPassive &&
		c.nativeZmodemSelectionID == selectionID && selectionID != 0 &&
		c.nativeTerminalTransfer == nil && c.aiController == nil && !c.nativeTerminalPoisoned
	if valid {
		valid = (direction == "upload" && c.nativeZmodemPassiveFrame == 1) ||
			(direction == "download" && c.nativeZmodemPassiveFrame == 0)
	}
	if valid {
		frame, _, pending := c.outputGuard.pendingCapture()
		valid = pending && frame == c.nativeZmodemPassiveFrame
	}
	if !valid {
		m.mu.Unlock()
		return false, apperror.New("zmodemDirectionMismatch", nil)
	}
	ctx, cancel := context.WithCancel(parent)
	task := &nativeTerminalTransferTask{ref: ref, cancel: cancel}
	c.nativeTerminalTransfer = task
	c.nativeZmodemSelection = false
	c.nativeZmodemSelectionPassive = false
	// Record an installer-verified token for this exact SSH generation
	// before relinquishing the manager mutex. A session that never
	// acknowledged the two-stage Bash challenge remains fail-closed.
	token := c.passiveBashHookToken
	if c.passiveBashHookInstalling { token = "" }
	c.nativeTerminalPoisoned = true
	input, output, guard := c.inputGate, c.outputGate, c.outputGuard
	m.mu.Unlock()
	defer cancel()
	m.emit("ssh:native-zmodem-selection", map[string]any{
		"ref": ref, "selectionId": selectionID, "active": false,
	})
	notifyNativeZmodemAccepted(ctx)
	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: nativeTerminalExecutableRunnerWithProgress(sidecar, progress),
	}
	var err error
	if token != "" {
		terminalSafe, err = coordinator.runPassiveVerified(ctx, direction, localPath, guard, token)
	} else {
		err = coordinator.runPassive(ctx, direction, localPath, guard)
	}
	m.mu.Lock()
	if current := m.connections[ref.TabID]; current == c && c.ref == ref &&
		c.nativeTerminalTransfer == task {
		c.nativeTerminalTransfer = nil
		if terminalSafe { c.nativeTerminalPoisoned = false }
	} else {
		// SSH reconnect/disconnect invalidates any old generation result.
		terminalSafe = false
	}
	m.mu.Unlock()
	if err != nil {
		if terminalSafe {
			return true, apperror.Wrap("zmodemPassiveFailedRecovered", err, nil)
		}
		return false, apperror.Wrap("zmodemFailedReconnect", err, nil)
	}
	return terminalSafe, nil
}
