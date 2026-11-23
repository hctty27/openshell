package sshclient

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/hctty27/openshell/internal/apperror"
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
		return apperror.New("zmodemFileTooLarge", nil)
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
	if n == nil || n.sidecar == "" { return apperror.New("zmodemExperimentDisabled", nil) }
	if ctx == nil { return apperror.New("zmodemMissingContext", nil) }
	if err := ctx.Err(); err != nil { return err }
	if req.Ref.TabID == "" { return apperror.New("zmodemMissingTab", nil) }
	if info, err := os.Stat(n.sidecar); err != nil || !info.Mode().IsRegular() {
		return apperror.New("zmodemSidecarNotFile", nil)
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
		return apperror.New("zmodemSSHManagerClosed", nil)
	}
	if n.active[req.Ref.TabID] != nil {
		n.mu.Unlock()
		cancel()
		return apperror.New("zmodemTerminalBusy", nil)
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
	if c == nil || c.ref != ref { return nil, apperror.New("sshDisconnectedOrConnectionChanged", nil) }
	if isJumpServerVersion(c.serverVersion) || c.readiness.isJumpServer() {
		return nil, apperror.New("zmodemJumpServerUnsupported", nil)
	}
	if c.nativeTerminalTransfer != nil || c.nativeTerminalPoisoned || c.aiController != nil {
		return nil, apperror.New("zmodemTerminalBusy", nil)
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
		return "", "", apperror.New("zmodemInvalidRemotePath", nil)
	}
	path := "'" + strings.ReplaceAll(remotePath, "'", "'\\''") + "'"
	switch direction {
	case "upload":
		return "cd -- " + path + " && stty raw -echo && exec rz -q", "send", nil
	case "download":
		return "stty raw -echo && exec sz -q -- " + path, "receive", nil
	default:
		return "", "", apperror.New("zmodemUnsupportedDirectionNamed", map[string]any{"direction": direction})
	}
}

func nativeZmodemLocalPath(direction, localPath string) (string, error) {
	if localPath == "" { return "", apperror.New("zmodemChooseLocalTarget", nil) }
	absolute, err := filepath.Abs(localPath)
	if err != nil { return "", err }
	info, err := os.Lstat(absolute)
	if err != nil { return "", err }
	if info.Mode()&os.ModeSymlink != 0 {
		return "", apperror.New("zmodemLocalSymlinkNotAllowed", nil)
	}
	switch direction {
	case "upload":
		if !info.Mode().IsRegular() { return "", apperror.New("zmodemUploadRegularFileOnly", nil) }
		if err := nativeZmodemCheckFileSize(info.Size()); err != nil { return "", err }
		if !utf8.ValidString(filepath.Base(absolute)) { return "", apperror.New("zmodemFileNameNotUTF8", nil) }
	case "download":
		if !info.IsDir() { return "", apperror.New("zmodemDownloadTargetNotDirectory", nil) }
	default:
		return "", apperror.New("zmodemUnsupportedDirection", nil)
	}
	return absolute, nil
}

// Publish exactly one fully received file after remote completion proof.
// Link atomically without ever replacing an existing destination file.
func nativeZmodemPublish(stage, destination string) error {
	entries, err := os.ReadDir(stage)
	if err != nil { return err }
	if len(entries) != 1 {
		return apperror.New("zmodemReceivedUnexpectedCount", map[string]any{"count": len(entries)})
	}
	name := entries[0].Name()
	if name == "." || name == ".." || filepath.Base(name) != name || !utf8.ValidString(name) {
		return apperror.New("zmodemInvalidRemoteFileName", nil)
	}
	source := filepath.Join(stage, name)
	info, err := os.Lstat(source)
	if err != nil { return err }
	if !info.Mode().IsRegular() { return apperror.New("zmodemReceivedNotRegularFile", nil) }
	target := filepath.Join(destination, name)
	if _, err := os.Lstat(target); err == nil {
		return apperror.New("zmodemLocalFileExists", map[string]any{"name": name})
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Link(source, target); err != nil {
		return apperror.Wrap("zmodemLocalSaveFailed", err, nil)
	}
	return nil
}
