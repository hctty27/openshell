package sshclient

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"
)

const nativeZmodemShutdownTimeout = 3 * time.Second

type nativeZmodemLog struct {
	mu sync.Mutex
	data []byte
}

func (l *nativeZmodemLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if remaining := 4096 - len(l.data); remaining > 0 {
		if len(p) < remaining { remaining = len(p) }
		l.data = append(l.data, p[:remaining]...)
	}
	return len(p), nil
}

func (l *nativeZmodemLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return string(bytes.TrimSpace(l.data))
}

// RunNativeZmodemTransport is experimental and is not connected to the
// interactive terminal. Each direction has exactly one reader of binary data.
func RunNativeZmodemTransport(ctx context.Context, client *ssh.Client, sidecar, direction, localPath, remoteCommand string) error {
	if err := ctx.Err(); err != nil { return err }
	if client == nil || sidecar == "" || localPath == "" || remoteCommand == "" {
		return errors.New("原生 ZMODEM 桥接参数不完整")
	}
	if direction != "send" && direction != "receive" {
		return fmt.Errorf("不支持的 ZMODEM 方向：%s", direction)
	}

	// A stalled channel-open reply must not block cancellation indefinitely.
	type openResult struct {
		session *ssh.Session
		err error
	}
	opened := make(chan openResult)
	go func() {
		session, err := client.NewSession()
		select {
		case opened <- openResult{session, err}:
		case <-ctx.Done():
			if session != nil { _ = session.Close() }
		}
	}()
	var session *ssh.Session
	select {
	case result := <-opened:
		if result.err != nil { return result.err }
		session = result.session
	case <-ctx.Done():
		return ctx.Err()
	}
	defer session.Close()

	remoteIn, err := session.StdinPipe()
	if err != nil { return err }
	remoteOut, err := session.StdoutPipe()
	if err != nil { return err }
	if err = session.RequestPty("dumb", 24, 80, ssh.TerminalModes{ssh.ECHO: 0}); err != nil {
		return fmt.Errorf("远程 PTY 创建失败：%w", err)
	}

	process := exec.CommandContext(ctx, sidecar, direction, localPath)
	process.WaitDelay = nativeZmodemShutdownTimeout
	log := &nativeZmodemLog{}
	process.Stderr = log
	localIn, err := process.StdinPipe()
	if err != nil { return err }
	localOut, err := process.StdoutPipe()
	if err != nil { return err }
	if err = session.Start(remoteCommand); err != nil {
		return fmt.Errorf("远程 rz/sz 启动失败：%w", err)
	}
	if err = process.Start(); err != nil {
		return fmt.Errorf("本地原生 ZMODEM 启动失败：%w", err)
	}
	defer func() {
		if process.Process != nil { _ = process.Process.Kill() }
		_ = session.Close()
	}()

	copied := make(chan error, 2)
	remoteOutputDone := make(chan struct{})
	localOutputDone := make(chan struct{})
	go func() {
		defer close(remoteOutputDone)
		_, copyErr := io.Copy(localIn, remoteOut)
		_ = localIn.Close()
		copied <- copyErr
	}()
	go func() {
		defer close(localOutputDone)
		_, copyErr := io.Copy(remoteIn, localOut)
		_ = remoteIn.Close()
		copied <- copyErr
	}()

	// Wait only after each stdout reader drains, otherwise Wait can close a
	// pipe while its reader is still processing final ZMODEM control frames.
	localFinished := make(chan error, 1)
	remoteFinished := make(chan error, 1)
	go func() { <-localOutputDone; localFinished <- process.Wait() }()
	go func() { <-remoteOutputDone; remoteFinished <- session.Wait() }()
	localDone, remoteDone := false, false
	var localErr, remoteErr error
	for !localDone || !remoteDone {
		select {
		case <-ctx.Done():
			_ = session.Close()
			_ = process.Process.Kill()
			waitForNativeZmodemShutdown(localFinished, remoteFinished, localDone, remoteDone)
			return fmt.Errorf("原生 ZMODEM 已取消或超时：%w", ctx.Err())
		case localErr = <-localFinished:
			localDone = true
			localFinished = nil
			if localErr != nil {
				_ = session.Close()
			}
		case remoteErr = <-remoteFinished:
			remoteDone = true
			remoteFinished = nil
			if remoteErr != nil {
				_ = process.Process.Kill()
			}
		}
	}
	if ctx.Err() != nil { return ctx.Err() }
	if localErr != nil { return fmt.Errorf("原生 ZMODEM 进程异常：%w；%s", localErr, log.String()) }
	if remoteErr != nil { return fmt.Errorf("远程 rz/sz 执行失败：%w", remoteErr) }

	for range 2 {
		select {
		case copyErr := <-copied:
			// These close notifications are expected only after both
			// protocol peers have exited successfully.
			if copyErr != nil && !errors.Is(copyErr, io.ErrClosedPipe) &&
				!errors.Is(copyErr, os.ErrClosed) && !errors.Is(copyErr, syscall.EPIPE) {
				return fmt.Errorf("ZMODEM 数据流中断：%w", copyErr)
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func waitForNativeZmodemShutdown(local, remote <-chan error, localDone, remoteDone bool) {
	timeout := time.NewTimer(nativeZmodemShutdownTimeout)
	defer timeout.Stop()
	for !localDone || !remoteDone {
		select {
		case <-local:
			localDone = true
			local = nil
		case <-remote:
			remoteDone = true
			remote = nil
		case <-timeout.C:
			return
		}
	}
}
