package main

import (
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
		if err != nil {
			payload["error"] = err.Error()
		}
		payload["terminalSafe"] = a.NativeZmodemInteractiveReadiness(ref).Ready
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

// Compatibility entrypoint for older frontends. Reject multiple paths in Go,
// not only in the picker: callers cannot bypass the single-file rule.
func (a *App) StartNativeZmodemInteractiveBatchTransfer(
	ref domain.ConnectionRef, direction string, localPaths, remotePaths []string,
) error {
	if len(localPaths) != 1 {
		return errors.New("ZMODEM 每次只允许传输一个文件")
	}
	if direction == "upload" {
		if len(remotePaths) > 1 || (len(remotePaths) == 1 && remotePaths[0] != "") {
			return errors.New("ZMODEM 上传仅使用当前终端目录")
		}
		return a.StartNativeZmodemInteractiveTransfer(ref, direction, localPaths[0], "")
	}
	if direction == "download" && len(remotePaths) == 1 {
		return a.StartNativeZmodemInteractiveTransfer(ref, direction, localPaths[0], remotePaths[0])
	}
	return errors.New("ZMODEM 每次只允许下载一个文件")
}

// Kept temporarily to return a clear error to an outdated UI binding.
func (a *App) SkipNativeZmodemPendingFile(_ domain.ConnectionRef, _ string, _ int) error {
	return errors.New("单文件 ZMODEM 不支持跳过文件，可直接取消传输")
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

// Retained only for older bindings; never opens a multi-file picker.
func (a *App) NativeZmodemChooseUploadFiles() ([]string, error) {
	file, err := a.NativeZmodemChooseUploadFile()
	if err != nil || file == "" {
		return nil, err
	}
	return []string{file}, nil
}
