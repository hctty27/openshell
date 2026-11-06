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

// NativeZmodemInteractiveReadiness is read-only. Its result cannot start or
// authorize a transfer; each start is separately checked by the backend.
func (a *App) NativeZmodemInteractiveReadiness(ref domain.ConnectionRef) sshclient.NativeZmodemExperimentReadiness {
	if !a.nativeZmodemPreferred() {
		return sshclient.NativeZmodemExperimentReadiness{
			Code: "disabled", Message: "当前平台未启用原生 ZMODEM",
		}
	}
	return a.ssh.NativeZmodemExperimentalReadiness(ref, nativeZmodemDesktopSidecarPath(), true)
}

// StartNativeZmodemInteractiveTransfer uses the tested, existing interactive
// SSH PTY and keeps the transfer bound to the exact active connection.
func (a *App) StartNativeZmodemInteractiveTransfer(
	ref domain.ConnectionRef, direction, localPath, remotePath string,
) error {
	return a.StartNativeZmodemInteractiveBatchTransfer(
		ref, direction, []string{localPath}, []string{remotePath},
	)
}

// Native batch transfers run as one SSH PTY lease and one ZMODEM session.
// Upload localPaths are files, download localPaths contains one directory,
// and download remotePaths lists each file to fetch.
func (a *App) StartNativeZmodemInteractiveBatchTransfer(
	ref domain.ConnectionRef, direction string, localPaths, remotePaths []string,
) (err error) {
	if status := a.NativeZmodemInteractiveReadiness(ref); !status.Ready {
		return errors.New(status.Message)
	}
	batchID := domain.NewID()
	files := make([]map[string]any, 0)
	if direction == "upload" {
		for _, name := range localPaths {
			entry := map[string]any{"name": filepath.Base(name)}
			if info, statErr := os.Stat(name); statErr == nil && info.Mode().IsRegular() {
				entry["total"] = info.Size()
			}
			files = append(files, entry)
		}
	} else {
		for _, name := range remotePaths {
			if strings.TrimSpace(name) != "" {
				files = append(files, map[string]any{"name": filepath.Base(name)})
			}
		}
	}
	a.emit("ssh:native-zmodem-batch", map[string]any{
		"ref": ref, "id": batchID, "direction": direction, "active": true, "files": files,
	})
	defer func() {
		payload := map[string]any{"ref": ref, "id": batchID, "direction": direction, "active": false}
		if err != nil { payload["error"] = err.Error() }
		a.emit("ssh:native-zmodem-batch", payload)
	}()
	ctx := sshclient.WithNativeZmodemFileObserver(a.ctx, func(event sshclient.NativeZmodemFileProgress) {
		a.emit("ssh:native-zmodem-file", map[string]any{
			"ref": ref, "batchId": batchID, "kind": event.Kind,
			"index": event.Index, "name": event.Name,
			"total": event.Total, "processed": event.Processed,
		})
	})
	return a.ssh.RunExperimentalNativeTerminalBatchTransferWithProgress(
		ctx, ref, nativeZmodemDesktopSidecarPath(), direction, localPaths, remotePaths,
		func(processed, total uint64) {
			a.emit("ssh:native-zmodem-progress", map[string]any{
				"ref": ref, "batchId": batchID, "direction": direction, "processed": processed, "total": total,
			})
		},
	)
}

func (a *App) CancelNativeZmodemInteractiveTransfer(ref domain.ConnectionRef) error {
	// 必须允许取消当前已运行的原生任务。
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

// NativeZmodemChooseUploadFiles uses the OS picker for a single batch session.
// An empty selection means the user cancelled, not an implicit transfer.
func (a *App) NativeZmodemChooseUploadFiles() ([]string, error) {
	if !a.nativeZmodemPreferred() {
		return nil, errors.New("当前平台未启用原生 ZMODEM")
	}
	if a.pickNativeZmodemFiles == nil {
		return nil, errors.New("当前环境没有可用的多文件选择对话框")
	}
	return a.pickNativeZmodemFiles()
}
