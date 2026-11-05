package sshclient

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/hctty27/openshell/internal/domain"
)

// nativeTerminalTransferTask is scoped to one exact ConnectionRef and
// interactive PTY. No Wails binding or UI invokes this experiment yet.
type nativeTerminalTransferTask struct {
	ref domain.ConnectionRef
	cancel context.CancelFunc
}

// All callers must hold Manager.mu. Cancellation is nonblocking and never
// tries to acquire an input/output gate while the manager lock is held.
func cancelNativeTerminalTransferLocked(c *connection) {
	if c != nil && c.nativeTerminalTransfer != nil {
		c.nativeTerminalTransfer.cancel()
	}
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

// runNativeTerminalExperiment is an internal, explicit opt-in test entrypoint.
// It deliberately does not expose an API to Wails or auto-detect rz/sz output.
func (m *Manager) runNativeTerminalExperiment(
	parent context.Context,
	ref domain.ConnectionRef,
	sidecar, direction, localPath, remotePath string,
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
	if c.transferring || c.zmodemSelection != nil ||
		c.aiController != nil || c.nativeTerminalTransfer != nil {
		m.mu.Unlock()
		return errors.New("当前终端正被其他任务占用")
	}
	ctx, cancel := context.WithCancel(parent)
	task := &nativeTerminalTransferTask{ref: ref, cancel: cancel}
	c.nativeTerminalTransfer = task
	input, output := c.inputGate, c.outputGate
	m.mu.Unlock()

	defer func() {
		cancel()
		m.mu.Lock()
		if c.nativeTerminalTransfer == task {
			c.nativeTerminalTransfer = nil
		}
		m.mu.Unlock()
	}()

	coordinator := &nativeTerminalCoordinator{
		input: input, output: output,
		runner: nativeTerminalExecutableRunner(sidecar),
	}
	if err := coordinator.run(ctx, direction, localPath, remotePath); err != nil {
		// A failed in-place ZMODEM transfer cannot safely return to the
		// legacy stream before the remote protocol is drained. The gate
		// stays leased until the terminal disconnects or is replaced.
		return fmt.Errorf("交互式原生 ZMODEM 失败，当前终端需要重新连接：%w", err)
	}
	return nil
}
