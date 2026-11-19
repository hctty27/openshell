package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/hctty27/openshell/internal/domain"
	sshclient "github.com/hctty27/openshell/internal/ssh"
)

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

// Readiness never authorizes a transfer; the actual start rechecks the live SSH generation.
func (a *App) NativeZmodemInteractiveReadiness(ref domain.ConnectionRef) sshclient.NativeZmodemExperimentReadiness {
	if !a.nativeZmodemPreferred() {
		return sshclient.NativeZmodemExperimentReadiness{
			Code: "disabled", Message: "当前平台未启用原生 ZMODEM",
		}
	}
	return a.ssh.NativeZmodemExperimentalReadiness(ref, nativeZmodemDesktopSidecarPath(), true)
}

// One SSH PTY lease, one sidecar process, one file and one UI task.
// The old batch event name is temporarily retained for frontend event compatibility.
func (a *App) StartNativeZmodemInteractiveTransfer(
	ref domain.ConnectionRef, direction, localPath, remotePath string,
) (err error) {
	if direction != "upload" && direction != "download" {
		return errors.New("不支持的 ZMODEM 传输方向")
	}
	if localPath == "" || strings.ContainsAny(localPath, "\r\n") {
		return errors.New("请选择一个本地文件或保存目录")
	}
	if direction == "download" && (remotePath == "" || strings.ContainsAny(remotePath, "\r\n")) {
		return errors.New("ZMODEM 每次只能下载一个远程文件")
	}
	if status := a.NativeZmodemInteractiveReadiness(ref); !status.Ready {
		return errors.New(status.Message)
	}

	id := domain.NewID()
	name := filepath.Base(localPath)
	file := map[string]any{"name": name}
	if direction == "upload" {
		if info, statErr := os.Stat(localPath); statErr == nil && info.Mode().IsRegular() {
			file["total"] = info.Size()
		}
	} else {
		name = filepath.Base(remotePath)
		file["name"] = name
	}

	a.emit("ssh:native-zmodem-batch", map[string]any{
		"ref": ref, "id": id, "direction": direction, "active": true,
		"files": []map[string]any{file},
	})
	defer func() {
		payload := map[string]any{"ref": ref, "id": id, "direction": direction, "active": false}
		terminalSafe := a.NativeZmodemInteractiveReadiness(ref).Ready
		payload["terminalSafe"] = terminalSafe
		if err != nil {
			payload["error"] = err.Error()
			// An interrupted but unverified SSH session is a failure that
			// needs reconnection, not a completed user cancellation.
			payload["cancelled"] = terminalSafe && errors.Is(err, context.Canceled)
		}
		a.emit("ssh:native-zmodem-batch", payload)
	}()

	ctx := sshclient.WithNativeZmodemFileObserver(a.ctx, func(event sshclient.NativeZmodemFileProgress) {
		if event.Index != 0 {
			return // Never surface a second file for a single-file transfer.
		}
		a.emit("ssh:native-zmodem-file", map[string]any{
			"ref": ref, "batchId": id, "kind": event.Kind,
			"index": 0, "name": event.Name,
			"total": event.Total, "processed": event.Processed,
		})
	})
	return a.ssh.RunExperimentalNativeTerminalTransferWithProgress(
		ctx, ref, nativeZmodemDesktopSidecarPath(), direction, localPath, remotePath,
		func(processed, total uint64) {
			a.emit("ssh:native-zmodem-progress", map[string]any{
				"ref": ref, "batchId": id, "direction": direction,
				"processed": processed, "total": total,
			})
		},
	)
}

func (a *App) CancelNativeZmodemInteractiveTransfer(ref domain.ConnectionRef) error {
	if !a.ssh.CancelExperimentalNativeTerminalTransfer(ref) {
		return errors.New("没有可取消的原生 ZMODEM 传输")
	}
	return nil
}

func (a *App) NativeZmodemChooseUploadFile() (string, error) {
	if !a.nativeZmodemPreferred() {
		return "", errors.New("当前平台未启用原生 ZMODEM")
	}
	if a.pickNativeZmodemFile == nil {
		return "", errors.New("当前环境没有可用的文件选择对话框")
	}
	return a.pickNativeZmodemFile()
}
