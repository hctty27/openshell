package sshclient

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/hctty27/openshell/internal/domain"
	"golang.org/x/crypto/ssh"
)

const (
	// Legacy ZMODEM transports use 32-bit positions; stay below 2 GiB for
	// compatibility with older and 32-bit lrzsz peers.
	nativeZmodemMaxFileSize = (2 << 30) - 1
)

func nativeZmodemCheckFileSize(size int64) error {
	if size < 0 || size > nativeZmodemMaxFileSize {
		return errors.New("原生 ZMODEM 单文件最大支持 2 GiB 以下")
	}
	return nil
}

type NativeZmodemRequest struct {
	Ref domain.ConnectionRef `json:"ref"`
	Direction string `json:"direction"`
	LocalPath string `json:"localPath"`
	RemotePath string `json:"remotePath"`
}

type nativeZmodemTask struct {
	ref domain.ConnectionRef
	cancel context.CancelFunc
}

type NativeZmodemManager struct {
	ssh *Manager
	emit EmitFunc
	sidecar string
	mu sync.Mutex
	active map[string]*nativeZmodemTask
	closed bool
	transport func(context.Context, *ssh.Client, string, string, string, string) error
}

func NewNativeZmodemManager(manager *Manager, emit EmitFunc, sidecar string) *NativeZmodemManager {
	if emit == nil { emit = func(string, any) {} }
	return &NativeZmodemManager{
		ssh: manager, emit: emit, sidecar: sidecar,
		active: make(map[string]*nativeZmodemTask),
		transport: RunNativeZmodemTransport,
	}
}

// Run is an opt-in developer experiment. It does not take ownership of the
// visible terminal's PTY, input stream or active trzsz-go filter.
func (n *NativeZmodemManager) Run(ctx context.Context, req NativeZmodemRequest) (err error) {
	if n == nil || n.sidecar == "" { return errors.New("原生 ZMODEM 实验未启用") }
	if ctx == nil { return errors.New("缺少传输上下文") }
	if err := ctx.Err(); err != nil { return err }
	if req.Ref.TabID == "" { return errors.New("缺少有效的 SSH 标签页") }
	if info, err := os.Stat(n.sidecar); err != nil || !info.Mode().IsRegular() {
		return errors.New("原生 ZMODEM sidecar 不存在或不是可执行文件")
	}
	command, direction, err := nativeZmodemRemoteCommand(req.Direction, req.RemotePath)
	if err != nil { return err }
	path, err := nativeZmodemLocalPath(req.Direction, req.LocalPath)
	if err != nil { return err }
	client, err := n.ssh.nativeZmodemClient(req.Ref)
	if err != nil { return err }

	transferCtx, cancel, _ := newNativeZmodemIdleContext(ctx, nativeZmodemTransferIdleTimeout)
	task := &nativeZmodemTask{ref: req.Ref, cancel: cancel}
	n.mu.Lock()
	if n.closed {
		n.mu.Unlock()
		cancel()
		return errors.New("原生 ZMODEM 管理器已关闭")
	}
	if n.active[req.Ref.TabID] != nil {
		n.mu.Unlock()
		cancel()
		return errors.New("当前标签页已经存在原生 ZMODEM 传输")
	}
	n.active[req.Ref.TabID] = task
	n.mu.Unlock()
	n.emit("ssh:native-zmodem-state", map[string]any{"ref": req.Ref, "active": true, "direction": req.Direction})
	defer func() {
		cancel()
		n.mu.Lock()
		if n.active[req.Ref.TabID] == task { delete(n.active, req.Ref.TabID) }
		n.mu.Unlock()
		event := map[string]any{"ref": req.Ref, "active": false, "direction": req.Direction}
		if err != nil { event["error"] = err.Error() }
		n.emit("ssh:native-zmodem-state", event)
	}()

	if direction == "receive" {
		// Isolate partial .part files and untrusted remote names from the
		// destination. A failed/cancelled transfer removes this entire stage.
		stage, stageErr := os.MkdirTemp(path, ".openshell-zmodem-native-")
		if stageErr != nil { return stageErr }
		defer os.RemoveAll(stage)
		if err = n.transport(transferCtx, client, n.sidecar, direction, stage, command); err != nil {
			if cause := nativeZmodemContextError(transferCtx); cause != nil { return cause }
			return err
		}
		if err = nativeZmodemContextError(transferCtx); err != nil { return err }
		return nativeZmodemPublish(stage, path)
	}
	err = n.transport(transferCtx, client, n.sidecar, direction, path, command)
	if cause := nativeZmodemContextError(transferCtx); cause != nil { return cause }
	return err
}

func (m *Manager) nativeZmodemClient(ref domain.ConnectionRef) (*ssh.Client, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.connections[ref.TabID]
	if c == nil || c.ref != ref { return nil, errors.New("SSH 会话已断开或发生变化") }
	if isJumpServerVersion(c.serverVersion) || c.readiness.isJumpServer() {
		return nil, errors.New("JumpServer 暂不支持原生 ZMODEM 独立执行")
	}
	if c.zmodemSelection != nil || c.transferring {
		return nil, errors.New("请先完成当前终端文件传输")
	}
	return c.client, nil
}

func (n *NativeZmodemManager) Cancel(ref domain.ConnectionRef) bool {
	if n == nil { return false }
	n.mu.Lock()
	task := n.active[ref.TabID]
	n.mu.Unlock()
	if task == nil || task.ref != ref { return false }
	task.cancel()
	return true
}

func (n *NativeZmodemManager) CancelConnection(ref domain.ConnectionRef) {
	_ = n.Cancel(ref)
}

func (n *NativeZmodemManager) Close() {
	if n == nil { return }
	n.mu.Lock()
	n.closed = true
	tasks := make([]*nativeZmodemTask, 0, len(n.active))
	for _, task := range n.active { tasks = append(tasks, task) }
	n.mu.Unlock()
	for _, task := range tasks { task.cancel() }
}

func nativeZmodemRemoteCommand(direction, remotePath string) (string, string, error) {
	if remotePath == "" || strings.IndexFunc(remotePath, unicode.IsControl) >= 0 {
		return "", "", errors.New("无效的远程路径")
	}
	path := "'" + strings.ReplaceAll(remotePath, "'", "'\\''") + "'"
	switch direction {
	case "upload":
		return "cd -- " + path + " && stty raw -echo && exec rz -q", "send", nil
	case "download":
		return "stty raw -echo && exec sz -q -- " + path, "receive", nil
	default:
		return "", "", fmt.Errorf("不支持的 ZMODEM 传输方向：%s", direction)
	}
}

func nativeZmodemLocalPath(direction, localPath string) (string, error) {
	if localPath == "" { return "", errors.New("缺少本地路径") }
	absolute, err := filepath.Abs(localPath)
	if err != nil { return "", err }
	info, err := os.Lstat(absolute)
	if err != nil { return "", err }
	if info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("原生 ZMODEM 实验不允许符号链接路径")
	}
	switch direction {
	case "upload":
		if !info.Mode().IsRegular() { return "", errors.New("上传仅支持普通文件") }
		if err := nativeZmodemCheckFileSize(info.Size()); err != nil { return "", err }
		if !utf8.ValidString(filepath.Base(absolute)) { return "", errors.New("文件名必须是 UTF-8") }
	case "download":
		if !info.IsDir() { return "", errors.New("下载目标必须是目录") }
	default:
		return "", errors.New("无效的 ZMODEM 方向")
	}
	return absolute, nil
}

// Publish only after every ZMODEM file and the remote shell boundary have
// been confirmed. Link each verified file without overwriting existing files;
// if any link fails, roll back the links created by this invocation.
func nativeZmodemPublish(stage, destination string) error {
    entries, err := os.ReadDir(stage)
    if err != nil { return err }
    if len(entries) < 1 || len(entries) > 100 {
        return fmt.Errorf("原生 ZMODEM 每次需要 1–100 个普通文件，实际收到 %d 项", len(entries))
    }
    type item struct{ source, target string }
    checked := make([]item, 0, len(entries))
    names := make(map[string]bool, len(entries))
    for _, entry := range entries {
        name := entry.Name()
        if name == "." || name == ".." || filepath.Base(name) != name || !utf8.ValidString(name) {
            return errors.New("远程文件名无效")
        }
        key := strings.ToLower(name)
        if names[key] { return fmt.Errorf("批量文件名冲突：%s", name) }
        names[key] = true
        source := filepath.Join(stage, name)
        info, err := os.Lstat(source)
        if err != nil { return err }
        if !info.Mode().IsRegular() { return errors.New("接收对象不是普通文件") }
        target := filepath.Join(destination, name)
        if _, err := os.Lstat(target); err == nil {
            return fmt.Errorf("目标文件已存在，不允许覆盖：%s", name)
        } else if !errors.Is(err, os.ErrNotExist) {
            return err
        }
        checked = append(checked, item{source, target})
    }
    published := make([]string, 0, len(checked))
    for _, file := range checked {
        // Staging and target are siblings on the same filesystem.
        if err := os.Link(file.source, file.target); err != nil {
            for _, target := range published { _ = os.Remove(target) }
            return fmt.Errorf("批量文件保存失败，已回滚（不允许覆盖）：%w", err)
        }
        published = append(published, file.target)
    }
    return nil
}

// Validate before acquiring the interactive PTY. The Rust sidecar rechecks
// each source independently, preventing a stale/changed path from bypassing
// its own filesystem and filename rules.
func nativeZmodemUploadPaths(paths []string) ([]string, error) {
    if len(paths) < 1 || len(paths) > 100 {
        return nil, errors.New("原生 ZMODEM 每次支持 1–100 个上传文件")
    }
    clean := make([]string, 0, len(paths))
    names := make(map[string]bool, len(paths))
    for _, path := range paths {
        if strings.ContainsRune(path, '\x00') { return nil, errors.New("文件路径包含非法 NUL 字符") }
        absolute, err := nativeZmodemLocalPath("upload", path)
        if err != nil { return nil, err }
        name := strings.ToLower(filepath.Base(absolute))
        if names[name] { return nil, fmt.Errorf("存在相同文件名，无法上传到同一目录：%s", name) }
        names[name] = true
        clean = append(clean, absolute)
    }
    return clean, nil
}

// Keep the existing one-path sidecar runner API. A protected NUL-separated
// manifest avoids command-line quoting, command length limits and file copying.
func nativeZmodemUploadManifest(paths []string) (path string, action string, cleanup func(), err error) {
    if len(paths) == 1 { return paths[0], "send", func() {}, nil }
    file, err := os.CreateTemp("", "openshell-native-zmodem-batch-*.list")
    if err != nil { return "", "", nil, err }
    cleanup = func() { _ = os.Remove(file.Name()) }
    for _, path := range paths {
        if _, err = file.Write(append([]byte(path), 0)); err != nil { break }
    }
    if closeErr := file.Close(); err == nil { err = closeErr }
    if err != nil { cleanup(); return "", "", nil, err }
    return file.Name(), "send-list", cleanup, nil
}

