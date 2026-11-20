package sshclient

import (
	"errors"

	"github.com/hctty27/openshell/internal/domain"
)

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
		!c.nativeTerminalPoisoned && !isJumpServerVersion(c.serverVersion) &&
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
	m.mu.Unlock()

	if !valid {
		m.emit("ssh:native-zmodem-unsupported", map[string]any{
			"ref": ref, "error": "检测到远端主动 ZMODEM 握手，但当前终端无法安全接管；协议数据已隔离，请重新连接 SSH",
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
		return "", errors.New("远端 ZMODEM 文件选择已失效")
	}
	if c.nativeZmodemPassiveFrame == 0 { return "download", nil }
	if c.nativeZmodemPassiveFrame == 1 { return "upload", nil }
	return "", errors.New("未知的远端 ZMODEM 握手类型")
}
