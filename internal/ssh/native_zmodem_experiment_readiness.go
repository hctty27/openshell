package sshclient

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
)

// NativeZmodemExperimentReadiness is a read-only preflight for a future
// explicitly enabled developer UI. It does NOT start the sidecar, run rz/sz,
// and never starts a transfer without native PTY authorization.
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
		return nativeZmodemReadiness("disabled", apperror.New("zmodemDisabledOnPlatform", nil).Error())
	}
	if m == nil {
		return nativeZmodemReadiness("no_connection", apperror.New("zmodemNoSSHManager", nil).Error())
	}
	if sidecarPath == "" || !filepath.IsAbs(sidecarPath) {
		return nativeZmodemReadiness("sidecar_missing", apperror.New("zmodemSidecarPathRequired", nil).Error())
	}
	if runtime.GOOS == "windows" && !strings.EqualFold(filepath.Ext(sidecarPath), ".exe") {
		return nativeZmodemReadiness("sidecar_invalid", apperror.New("zmodemSidecarMustBeExe", nil).Error())
	}
	info, err := os.Lstat(sidecarPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nativeZmodemReadiness("sidecar_invalid", apperror.New("zmodemSidecarNotFile", nil).Error())
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0111 == 0 {
		return nativeZmodemReadiness("sidecar_invalid", apperror.New("zmodemSidecarNotExecutable", nil).Error())
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nativeZmodemReadiness("no_connection", apperror.New("zmodemSSHManagerClosed", nil).Error())
	}
	c := m.connections[ref.TabID]
	if c == nil || c.ref != ref || c.client == nil || c.terminal == nil ||
		c.inputGate == nil || c.outputGate == nil {
		return nativeZmodemReadiness("no_connection", apperror.New("zmodemTerminalGone", nil).Error())
	}
	if c.nativeTerminalPoisoned {
		return nativeZmodemReadiness("needs_reconnect", apperror.New("zmodemNeedsReconnect", nil).Error())
	}
	if isJumpServerVersion(c.serverVersion) || c.readiness.isJumpServer() {
		return nativeZmodemReadiness("jumpserver_unsupported", apperror.New("zmodemJumpServerUnsupported", nil).Error())
	}
	if c.aiController != nil || c.nativeTerminalTransfer != nil || c.nativeZmodemSelectionPassive {
		return nativeZmodemReadiness("busy", apperror.New("zmodemTerminalBusy", nil).Error())
	}
	return nativeZmodemReadiness("ready", apperror.New("zmodemReady", nil).Error())
}
