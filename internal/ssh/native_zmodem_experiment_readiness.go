package sshclient

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/hctty27/openshell/internal/domain"
)

// NativeZmodemExperimentReadiness is a read-only preflight for a future
// explicitly enabled developer UI. It does NOT start the sidecar, run rz/sz,
// or change the default trzsz-go/MSYS2 transfer path.
type NativeZmodemExperimentReadiness struct {
	Ready bool `json:"ready"`
	Code string `json:"code"`
	Message string `json:"message"`
}

func nativeZmodemReadiness(code, message string) NativeZmodemExperimentReadiness {
	return NativeZmodemExperimentReadiness{Ready: code == "ready", Code: code, Message: message}
}

// NativeZmodemExperimentalReadiness must be called only after a separate,
// explicit experiment opt-in. Even a ready result is not permission to
// invoke a transfer automatically: file and direction selection, separate
// user authorization, and remote shell compatibility remain prerequisites.
func (m *Manager) NativeZmodemExperimentalReadiness(
	ref domain.ConnectionRef, sidecarPath string, optedIn bool,
) NativeZmodemExperimentReadiness {
	if !optedIn {
		return nativeZmodemReadiness("disabled", "原生 ZMODEM 实验未启用，继续使用现有 rz/sz")
	}
	if m == nil {
		return nativeZmodemReadiness("no_connection", "SSH 连接管理器不可用")
	}
	if sidecarPath == "" || !filepath.IsAbs(sidecarPath) {
		return nativeZmodemReadiness("sidecar_missing", "需要明确指定原生 ZMODEM sidecar 的绝对路径")
	}
	if runtime.GOOS == "windows" && !strings.EqualFold(filepath.Ext(sidecarPath), ".exe") {
		return nativeZmodemReadiness("sidecar_invalid", "Windows 原生 sidecar 必须为 EXE")
	}
	info, err := os.Lstat(sidecarPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nativeZmodemReadiness("sidecar_invalid", "原生 ZMODEM sidecar 文件不存在或不是普通文件")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0111 == 0 {
		return nativeZmodemReadiness("sidecar_invalid", "原生 ZMODEM sidecar 没有执行权限")
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nativeZmodemReadiness("no_connection", "SSH 管理器已关闭")
	}
	c := m.connections[ref.TabID]
	if c == nil || c.ref != ref || c.client == nil || c.terminal == nil ||
		c.inputGate == nil || c.outputGate == nil {
		return nativeZmodemReadiness("no_connection", "当前交互式 SSH 终端不可用或连接代际已变化")
	}
	if c.nativeTerminalPoisoned {
		return nativeZmodemReadiness("needs_reconnect", "上次原生传输状态不确定，需要先重新连接 SSH 终端")
	}
	if isJumpServerVersion(c.serverVersion) || c.readiness.isJumpServer() {
		return nativeZmodemReadiness("jumpserver_unsupported", "JumpServer 暂不支持原生 ZMODEM 接管")
	}
	if c.transferring || c.zmodemSelection != nil ||
		c.aiController != nil || c.nativeTerminalTransfer != nil {
		return nativeZmodemReadiness("busy", "当前终端存在文件传输或 AI 独占任务")
	}
	return nativeZmodemReadiness("ready", "实验环境已就绪，仍需显式选择文件和方向")
}
