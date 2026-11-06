package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"

	"github.com/hctty27/openshell/internal/domain"
	sshclient "github.com/hctty27/openshell/internal/ssh"
)

// 原生 ZMODEM 只允许显式开发者 opt-in；正式 rz/sz 默认路径保持不变。
func (a *App) NativeZmodemExperimentEnabled() bool {
	return os.Getenv("OPENSHELL_NATIVE_ZMODEM_EXPERIMENT") == "1"
}

func nativeZmodemDesktopSidecarPath() string {
	if explicit := os.Getenv("OPENSHELL_NATIVE_ZMODEM_SIDECAR"); explicit != "" {
		return explicit
	}
	if runtime.GOOS != "windows" {
		return ""
	}
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Join(filepath.Dir(executable), "zmodem", "native", "zmodem-sidecar.exe")
}

// NativeZmodemInteractiveReadiness is read-only. Its result cannot start or
// authorize a transfer; each start is separately checked by the backend.
func (a *App) NativeZmodemInteractiveReadiness(ref domain.ConnectionRef) sshclient.NativeZmodemExperimentReadiness {
	if !a.NativeZmodemExperimentEnabled() {
		return sshclient.NativeZmodemExperimentReadiness{
			Code: "disabled", Message: "原生 ZMODEM 实验未启用",
		}
	}
	return a.ssh.NativeZmodemExperimentalReadiness(ref, nativeZmodemDesktopSidecarPath(), true)
}

// StartNativeZmodemInteractiveTransfer uses the tested, existing interactive
// SSH PTY. It does not start an independent SSH exec session or intercept
// legacy rz/sz auto-detection.
func (a *App) StartNativeZmodemInteractiveTransfer(
	ref domain.ConnectionRef, direction, localPath, remotePath string,
) error {
	if status := a.NativeZmodemInteractiveReadiness(ref); !status.Ready {
		return errors.New(status.Message)
	}
	return a.ssh.RunExperimentalNativeTerminalTransfer(
		a.ctx, ref, nativeZmodemDesktopSidecarPath(), direction, localPath, remotePath,
	)
}

func (a *App) CancelNativeZmodemInteractiveTransfer(ref domain.ConnectionRef) error {
	if !a.NativeZmodemExperimentEnabled() {
		return errors.New("原生 ZMODEM 实验未启用")
	}
	if !a.ssh.CancelExperimentalNativeTerminalTransfer(ref) {
		return errors.New("没有可取消的原生 ZMODEM 传输")
	}
	return nil
}

func (a *App) NativeZmodemChooseUploadFile() (string, error) {
	if !a.NativeZmodemExperimentEnabled() {
		return "", errors.New("原生 ZMODEM 实验未启用")
	}
	if a.pickNativeZmodemFile == nil {
		return "", errors.New("当前环境没有可用的文件选择对话框")
	}
	return a.pickNativeZmodemFile()
}
