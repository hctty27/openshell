package sshclient

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/hctty27/openshell/internal/domain"
)

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
		"error": "远端 ZMODEM 等待选择文件超时；远端 Shell 状态未确认，请重新连接 SSH",
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


// RunPassiveNativeZmodemTransfer consumes a remote-triggered ZMODEM session.
// It deliberately cannot restore the terminal until a trusted remote shell
// exit boundary is implemented. This method is for the opt-in experiment.
func (m *Manager) RunPassiveNativeZmodemTransfer(
	parent context.Context, ref domain.ConnectionRef, selectionID uint64,
	sidecar, direction, localPath string, progress func(uint64, uint64),
) error {
	if parent == nil { return errors.New("缺少远端 ZMODEM 自动传输上下文") }
	if err := parent.Err(); err != nil { return err }
	if sidecar == "" { return errors.New("未配置原生 ZMODEM sidecar") }
	if info, err := os.Lstat(sidecar); err != nil || !info.Mode().IsRegular() ||
		info.Mode()&os.ModeSymlink != 0 {
		return errors.New("远端 ZMODEM 的本地原生 sidecar 无效")
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
		return errors.New("远端 ZMODEM 自动传输选择已失效或方向不匹配")
	}
	ctx, cancel := context.WithCancel(parent)
	task := &nativeTerminalTransferTask{ref: ref, cancel: cancel}
	c.nativeTerminalTransfer = task
	c.nativeZmodemSelection = false
	c.nativeZmodemSelectionPassive = false
	// The remote command was *not* wrapped by a nonce-bound exit marker.
	// Never let a successful local transfer silently resume this PTY.
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
	err := coordinator.runPassive(ctx, direction, localPath, guard)
	m.mu.Lock()
	if c.nativeTerminalTransfer == task { c.nativeTerminalTransfer = nil }
	m.mu.Unlock()
	if err != nil {
		return fmt.Errorf("远端 ZMODEM 自动传输异常（当前终端不可继续输入，需重连）：%w", err)
	}
	return nil
}
