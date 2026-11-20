package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"

	"github.com/hctty27/openshell/internal/domain"
	sshclient "github.com/hctty27/openshell/internal/ssh"
)

// Each native transfer receives an increasing generation within the app process.
// Event listeners can discard late start/end callbacks from older tasks.
var nativeZmodemTransferSequence atomic.Uint64

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
	if direction != "upload" && direction != "upload-overwrite" && direction != "download" {
		return errors.New("不支持的 ZMODEM 传输方向")
	}
	isUpload := direction != "download"
	displayDirection := "download"
	if isUpload { displayDirection = "upload" }
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
	sequence := nativeZmodemTransferSequence.Add(1)
	name := filepath.Base(localPath)
	file := map[string]any{"name": name}
	if isUpload {
		if info, statErr := os.Stat(localPath); statErr == nil && info.Mode().IsRegular() {
			file["total"] = info.Size()
		}
	} else {
		name = filepath.Base(remotePath)
		file["name"] = name
	}

	started := false
	defer func() {
		if !started {
			// The manager rejected this task before obtaining SSH ownership.
			// The caller receives the error without any spurious task events.
			return
		}
		payload := map[string]any{"ref": ref, "id": id, "sequence": sequence, "direction": displayDirection, "active": false}
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
	ctx = sshclient.WithNativeZmodemAcceptedObserver(ctx, func() {
		started = true
		a.emit("ssh:native-zmodem-batch", map[string]any{
			"ref": ref, "id": id, "sequence": sequence, "direction": displayDirection, "active": true,
			"overwrite": direction == "upload-overwrite",
			"files": []map[string]any{file},
		})
	})
	return a.ssh.RunExperimentalNativeTerminalTransferWithProgress(
		ctx, ref, nativeZmodemDesktopSidecarPath(), direction, localPath, remotePath,
		func(processed, total uint64) {
			a.emit("ssh:native-zmodem-progress", map[string]any{
				"ref": ref, "batchId": id, "direction": displayDirection,
				"processed": processed, "total": total,
			})
		},
	)
}

// StartNativeZmodemPassiveTransfer consumes a protocol session that was
// already started by the remote process. It MUST NOT launch a second rz/sz.
// This experiment is enabled only by OPENSHELL_ZMODEM_PASSIVE_EXPERIMENT=1.
func (a *App) StartNativeZmodemPassiveTransfer(
	ref domain.ConnectionRef, selectionID uint64, direction, localPath string,
) (err error) {
	if os.Getenv("OPENSHELL_ZMODEM_PASSIVE_EXPERIMENT") != "1" ||
		!a.nativeZmodemPreferred() {
		return errors.New("远端主动 ZMODEM 接管实验未启用")
	}
	if localPath == "" || strings.ContainsAny(localPath, "\r\n") {
		return errors.New("请选择本地文件或保存目录")
	}
	expected, err := a.ssh.PassiveZmodemSelection(ref, selectionID)
	if err != nil { return err }
	if expected != direction { return errors.New("远端 ZMODEM 接管方向与选择不匹配") }

	id := domain.NewID()
	sequence := nativeZmodemTransferSequence.Add(1)
	file := map[string]any{"name": "远端文件"}
	if direction == "upload" {
		file["name"] = filepath.Base(localPath)
		if info, statErr := os.Stat(localPath); statErr == nil && info.Mode().IsRegular() {
			file["total"] = info.Size()
		}
	}
	started := false
	defer func() {
		if !started { return }
		payload := map[string]any{
			"ref": ref, "id": id, "sequence": sequence,
			"direction": direction, "active": false, "terminalSafe": false,
		}
		if err != nil {
			payload["error"] = err.Error()
			payload["cancelled"] = errors.Is(err, context.Canceled)
		}
		a.emit("ssh:native-zmodem-batch", payload)
		if err == nil {
			a.emit("ssh:native-zmodem-unsupported", map[string]any{
				"ref": ref,
				"error": "远端 ZMODEM 文件传输完成；尚无法证明远端 Shell 已退出，必须重新连接 SSH 后继续输入命令",
			})
		}
	}()
	ctx := sshclient.WithNativeZmodemFileObserver(a.ctx, func(event sshclient.NativeZmodemFileProgress) {
		if event.Index != 0 { return }
		a.emit("ssh:native-zmodem-file", map[string]any{
			"ref": ref, "batchId": id, "kind": event.Kind,
			"index": 0, "name": event.Name,
			"total": event.Total, "processed": event.Processed,
		})
	})
	ctx = sshclient.WithNativeZmodemAcceptedObserver(ctx, func() {
		started = true
		a.emit("ssh:native-zmodem-batch", map[string]any{
			"ref": ref, "id": id, "sequence": sequence,
			"direction": direction, "active": true,
			"files": []map[string]any{file},
		})
	})
	return a.ssh.RunPassiveNativeZmodemTransfer(
		ctx, ref, selectionID, nativeZmodemDesktopSidecarPath(), direction, localPath,
		func(processed, total uint64) {
			a.emit("ssh:native-zmodem-progress", map[string]any{
				"ref": ref, "batchId": id, "direction": direction,
				"processed": processed, "total": total,
			})
		},
	)
}

// CancelNativeZmodemSelection closes only a pending picker reservation.
// A task already admitted to the native coordinator is never interrupted.
func (a *App) CancelNativeZmodemSelection(ref domain.ConnectionRef, selectionID uint64) error {
	if !a.ssh.ReleaseNativeZmodemSelection(ref, selectionID) {
		return errors.New("原生 ZMODEM 文件选择已结束或不是当前会话")
	}
	return nil
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
