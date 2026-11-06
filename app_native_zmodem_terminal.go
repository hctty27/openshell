package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/hctty27/openshell/internal/domain"
	sshclient "github.com/hctty27/openshell/internal/ssh"
)

type nativeZmodemSkipControl struct {
    batchID string
    path string
    activeIndex int
    fileCount int
    requested map[int]bool
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
	var skipPath string
	if (direction == "upload" && len(localPaths) > 1) || (direction == "download" && len(remotePaths) > 1) {
		dir, tempErr := os.MkdirTemp("", "openshell-zmodem-skip-")
		if tempErr != nil { return tempErr }
		defer os.RemoveAll(dir)
		skipPath = filepath.Join(dir, "pending")
		if err = os.WriteFile(skipPath, nil, 0600); err != nil { return err }
		control := &nativeZmodemSkipControl{
			batchID: batchID, path: skipPath, activeIndex: 0,
			fileCount: len(files), requested: make(map[int]bool),
		}
		a.mu.Lock()
		if a.nativeZmodemSkips == nil {
			a.nativeZmodemSkips = make(map[domain.ConnectionRef]*nativeZmodemSkipControl)
		}
		if a.nativeZmodemSkips[ref] != nil {
			a.mu.Unlock()
			return errors.New("当前终端已有正在执行的原生 ZMODEM 批次")
		}
		a.nativeZmodemSkips[ref] = control
		a.mu.Unlock()
		defer func() {
			a.mu.Lock()
			if a.nativeZmodemSkips[ref] == control { delete(a.nativeZmodemSkips, ref) }
			a.mu.Unlock()
		}()
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
		if event.Kind == "start" {
			a.mu.Lock()
			if control := a.nativeZmodemSkips[ref]; control != nil && control.batchID == batchID && event.Index > control.activeIndex {
				control.activeIndex = event.Index
			}
			a.mu.Unlock()
		}
		a.emit("ssh:native-zmodem-file", map[string]any{
			"ref": ref, "batchId": batchID, "kind": event.Kind,
			"index": event.Index, "name": event.Name,
			"total": event.Total, "processed": event.Processed,
		})
	})
	if skipPath != "" { ctx = sshclient.WithNativeZmodemSkipControl(ctx, skipPath) }
	return a.ssh.RunExperimentalNativeTerminalBatchTransferWithProgress(
		ctx, ref, nativeZmodemDesktopSidecarPath(), direction, localPaths, remotePaths,
		func(processed, total uint64) {
			a.emit("ssh:native-zmodem-progress", map[string]any{
				"ref": ref, "batchId": batchID, "direction": direction, "processed": processed, "total": total,
			})
		},
	)
}


func (a *App) SkipNativeZmodemPendingFile(ref domain.ConnectionRef, batchID string, index int) error {
	a.mu.Lock()
	control := a.nativeZmodemSkips[ref]
	if control == nil || control.batchID != batchID {
		a.mu.Unlock()
		return errors.New("原生 ZMODEM 批次已结束或不支持文件跳过")
	}
	if index <= control.activeIndex || index >= control.fileCount {
		a.mu.Unlock()
		return errors.New("该文件已开始传输，只能跳过尚未开始的文件")
	}
	if control.requested[index] {
		a.mu.Unlock()
		return nil
	}
	file, err := os.OpenFile(control.path, os.O_WRONLY|os.O_APPEND, 0600)
	if err == nil {
		_, err = fmt.Fprintf(file, "%d\n", index)
		if err == nil { err = file.Sync() }
		if closeErr := file.Close(); err == nil { err = closeErr }
	}
	if err == nil { control.requested[index] = true }
	a.mu.Unlock()
	if err != nil { return fmt.Errorf("提交跳过文件请求失败：%w", err) }
	a.emit("ssh:native-zmodem-file", map[string]any{
		"ref": ref, "batchId": batchID, "kind": "skip-requested",
		"index": index,
	})
	return nil
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
