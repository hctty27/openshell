package sshclient

import (
	"github.com/hctty27/openshell/internal/apperror"
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/hctty27/openshell/internal/domain"
)

// nativeTerminalTransferTask is scoped to one exact ConnectionRef and
// interactive PTY.
type nativeTerminalTransferTask struct {
	ref domain.ConnectionRef
	cancel context.CancelFunc
}

// The UI's "running" event must be emitted only after the SSH manager
// admits this task. A rejected concurrent start must not lock the terminal
// or create an orphaned transfer-center row.
type nativeZmodemAcceptedObserverKey struct{}

func WithNativeZmodemAcceptedObserver(ctx context.Context, onAccepted func()) context.Context {
	if onAccepted == nil { return ctx }
	return context.WithValue(ctx, nativeZmodemAcceptedObserverKey{}, onAccepted)
}

func notifyNativeZmodemAccepted(ctx context.Context) {
	if ctx == nil { return }
	if callback, ok := ctx.Value(nativeZmodemAcceptedObserverKey{}).(func()); ok && callback != nil {
		callback()
	}
}

// All callers must hold Manager.mu. Cancellation is nonblocking and never
// tries to acquire an input/output gate while the manager lock is held.
func cancelNativeTerminalTransferLocked(c *connection) {
	if c != nil && c.nativeTerminalTransfer != nil {
		c.nativeTerminalTransfer.cancel()
	}
}

// ReleaseNativeZmodemSelection clears only a picker reservation belonging
// to the exact SSH generation. It never cancels a running Rust transfer.
func (m *Manager) ReleaseNativeZmodemSelection(ref domain.ConnectionRef, selectionID uint64) bool {
	m.mu.Lock()
	c := m.connections[ref.TabID]
	if c == nil || c.ref != ref || !c.nativeZmodemSelection ||
		selectionID == 0 || selectionID != c.nativeZmodemSelectionID {
		m.mu.Unlock()
		return false
	}
	passive := c.nativeZmodemSelectionPassive
	guard := c.outputGuard
	c.nativeZmodemSelection = false
	c.nativeZmodemSelectionPassive = false
	if passive {
		// The remote program is already executing. Dismissing its picker
		// is not proof that the remote shell has exited.
		c.nativeTerminalPoisoned = true
	} else if c.nativeTerminalTransfer == nil && !c.nativeTerminalPoisoned {
		// The explicit command was erased with Ctrl-U before executing.
		c.readiness.restoreClearedNativeZmodemPrompt()
	}
	m.mu.Unlock()
	if passive && guard != nil { guard.discardCapture() }
	if passive {
		// The frontend must learn that the PTY is unsafe before receiving
		// the selection-release event. Never create a brief typing window.
		m.emit("ssh:native-zmodem-unsupported", map[string]any{
			"ref": ref, "error": apperror.New("zmodemPassiveSelectionCancelled", nil).Error(),
		})
	}
	m.emit("ssh:native-zmodem-selection", map[string]any{
		"ref": ref, "selectionId": selectionID, "active": false,
	})
	return true
}

func (m *Manager) CancelExperimentalNativeTerminalTransfer(ref domain.ConnectionRef) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.connections[ref.TabID]
	if c == nil || c.ref != ref || c.nativeTerminalTransfer == nil {
		return false
	}
	c.nativeTerminalTransfer.cancel()
	return true
}

// runNativeTerminalExperiment is an internal single-file test entrypoint.
func (m *Manager) runNativeTerminalExperiment(
	parent context.Context,
	ref domain.ConnectionRef,
	sidecar, direction, localPath, remotePath string,
) error {
	return m.runNativeTerminalExperimentWithProgress(parent, ref, sidecar, direction, localPath, remotePath, nil)
}

func (m *Manager) runNativeTerminalExperimentWithProgress(
	parent context.Context,
	ref domain.ConnectionRef,
	sidecar, direction, localPath, remotePath string,
	progress func(uint64, uint64),
) error {
	if parent == nil {
		return errors.New("缺少原生终端传输上下文")
	}
	if err := parent.Err(); err != nil {
		return err
	}
	if sidecar == "" {
		return errors.New("未指定实验原生 ZMODEM sidecar")
	}
	info, err := os.Stat(sidecar)
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("实验原生 ZMODEM sidecar 无效")
	}

	m.mu.Lock()
	c := m.connections[ref.TabID]
	if c == nil || c.ref != ref || c.terminal == nil ||
		c.inputGate == nil || c.outputGate == nil || m.closed {
		m.mu.Unlock()
		return errors.New("当前 SSH 终端已经关闭或引用失效")
	}
	if isJumpServerVersion(c.serverVersion) || c.readiness.isJumpServer() {
		m.mu.Unlock()
		return errors.New("JumpServer 暂不支持交互式原生 ZMODEM")
	}
	if c.aiController != nil || c.nativeTerminalTransfer != nil || c.nativeTerminalPoisoned || c.nativeZmodemSelectionPassive {
		m.mu.Unlock()
		return errors.New("当前终端正被其他任务占用")
	}
	ctx, cancel := context.WithCancel(parent)
	task := &nativeTerminalTransferTask{ref: ref, cancel: cancel}
	c.nativeTerminalTransfer = task
	// Picker ownership becomes task ownership atomically.
	selectionID := uint64(0)
	if c.nativeZmodemSelection { selectionID = c.nativeZmodemSelectionID }
	c.nativeZmodemSelection = false
	input, output := c.inputGate, c.outputGate
	m.mu.Unlock()

	if selectionID != 0 {
		m.emit("ssh:native-zmodem-selection", map[string]any{
			"ref": ref, "selectionId": selectionID, "active": false,
		})
	}
	defer cancel()
	// The ownership token is installed before the observer can announce
	// the task to listeners. Rejected starts never emit an active event.
	notifyNativeZmodemAccepted(ctx)

	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: nativeTerminalExecutableRunnerWithProgress(sidecar, progress),
	}
	result := coordinator.run(ctx, direction, localPath, remotePath)
	// Reading the gate before taking Manager.mu avoids lock inversion with
	// user-input writes. A stuck lease means the terminal is unsafe to reuse.
	input.mu.Lock()
	unsafe := input.leased
	input.mu.Unlock()
	m.mu.Lock()
	if c.nativeTerminalTransfer == task {
		c.nativeTerminalTransfer = nil
		if unsafe { c.nativeTerminalPoisoned = true }
	}
	m.mu.Unlock()
	if result != nil {
		if unsafe {
			return fmt.Errorf("交互式原生 ZMODEM 未安全结束，当前终端需要重新连接：%w", result)
		}
		// A nonce-bound remote exit marker already proved the shell is back.
		// Do not demand reconnect after a safely recovered cancellation.
		return result
	}
	return nil
}


// RunExperimentalNativeTerminalTransfer starts the production interactive
// PTY path. Readiness and exact connection ownership are rechecked.
func (m *Manager) RunExperimentalNativeTerminalTransfer(
	ctx context.Context,
	ref domain.ConnectionRef,
	sidecar, direction, localPath, remotePath string,
) error {
	return m.RunExperimentalNativeTerminalTransferWithProgress(ctx, ref, sidecar, direction, localPath, remotePath, nil)
}

// One transfer lease, one Rust sidecar, one source and one target.
func (m *Manager) RunExperimentalNativeTerminalTransferWithProgress(
	ctx context.Context,
	ref domain.ConnectionRef,
	sidecar, direction, localPath, remotePath string,
	progress func(uint64, uint64),
) error {
	status := m.NativeZmodemExperimentalReadiness(ref, sidecar, true)
	if !status.Ready { return errors.New(status.Message) }
	return m.runNativeTerminalExperimentWithProgress(ctx, ref, sidecar, direction, localPath, remotePath, progress)
}
