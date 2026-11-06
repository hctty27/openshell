package sshclient

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"time"
)

// nativeTerminalProtocolWriter is the only route allowed to write native
// ZMODEM control frames into an already-open interactive SSH PTY.
type nativeTerminalProtocolWriter struct {
	gate *terminalInputGate
	lease uint64
}

func (w nativeTerminalProtocolWriter) Write(p []byte) (int, error) {
	return w.gate.writeNative(w.lease, p)
}

// runNativeZmodemTerminalSidecar supervises one local Rust protocol process.
// inbound is a DEDICATED, closable stream (typically an io.PipeReader fed by
// terminalOutputGate), never the SSH terminal itself. outbound must be a
// nativeTerminalProtocolWriter holding the current terminal input lease.
//
// This is a non-shipping building block. The application does not call it;
// the full input/output handoff coordinator still requires separate review.
func runNativeZmodemTerminalSidecar(
	ctx context.Context, executable, direction, path string,
	inbound io.ReadCloser, outbound io.Writer,
) error {
	return runNativeZmodemTerminalSidecarWithProgress(ctx, executable, direction, path, inbound, outbound, nil)
}

func runNativeZmodemTerminalSidecarWithProgress(
	ctx context.Context, executable, direction, path string,
	inbound io.ReadCloser, outbound io.Writer, onProgress func(uint64, uint64),
) error {
	if ctx == nil { return errors.New("缺少原生 ZMODEM 进程上下文") }
	if err := ctx.Err(); err != nil { return err }
	if executable == "" || path == "" || inbound == nil || outbound == nil {
		return errors.New("原生 ZMODEM 进程参数不完整")
	}
	if direction != "send" && direction != "send-list" && direction != "receive" {
		return fmt.Errorf("不支持的 ZMODEM 传输方向：%s", direction)
	}

	cmd := exec.CommandContext(ctx, executable, direction, path)
	configureNativeZmodemSidecar(cmd)
	cmd.WaitDelay = nativeZmodemShutdownTimeout
	stderr := &nativeZmodemLog{}
	cmd.Stderr = stderr
	if fileObserver := nativeZmodemFileObserver(ctx); onProgress != nil || fileObserver != nil {
		cmd.Stderr = &nativeTerminalProgressLog{log: stderr, onProgress: onProgress, onFile: fileObserver}
	}
	stdin, err := cmd.StdinPipe()
	if err != nil { return err }
	stdout, err := cmd.StdoutPipe()
	if err != nil { return err }
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = inbound.Close()
		return fmt.Errorf("原生 ZMODEM sidecar 启动失败：%w", err)
	}
	// One goroutine in each direction; stdout is exclusively binary protocol,
	// while bounded diagnostic text is captured from stderr.
	inputDone := make(chan error, 1)
	outputDone := make(chan error, 1)
	go func() {
		_, copyErr := io.Copy(stdin, inbound)
		_ = stdin.Close()
		inputDone <- copyErr
	}()
	go func() {
		_, copyErr := io.Copy(outbound, stdout)
		outputDone <- copyErr
	}()

	stop := func() {
		_ = inbound.Close()
		_ = stdin.Close()
		_ = stdout.Close()
		if cmd.Process != nil { _ = cmd.Process.Kill() }
	}

	var outputErr error
	select {
	case outputErr = <-outputDone:
		// Closing only the dedicated pipe prevents a lingering inbound reader
		// from keeping the terminal coordinator alive after sidecar exit.
		_ = inbound.Close()
		_ = stdin.Close()
		if outputErr != nil { stop() }
	case <-ctx.Done():
		stop()
		// We must reap the child even if a remote SSH writer is stalled.
		reap := make(chan error, 1)
		go func() { reap <- cmd.Wait() }()
		select {
		case <-reap:
		case <-time.After(nativeZmodemShutdownTimeout):
		}
		return fmt.Errorf("原生 ZMODEM sidecar 已取消或超时：%w", ctx.Err())
	}

	// os/exec requires the stdout reader to finish before Cmd.Wait, otherwise
	// Wait can close its pipe while io.Copy still consumes final control bytes.
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()
	var processErr error
	select {
	case processErr = <-waited:
	case <-ctx.Done():
		stop()
		select {
		case <-waited:
		case <-time.After(nativeZmodemShutdownTimeout):
		}
		return fmt.Errorf("原生 ZMODEM sidecar 已取消或超时：%w", ctx.Err())
	}
	select {
	case <-inputDone:
	case <-time.After(nativeZmodemShutdownTimeout):
		return errors.New("原生 ZMODEM sidecar 输入协程未正常退出")
	}
	if meter := nativeZmodemIOMeterFromContext(ctx); meter != nil {
		meter.recordReceiverDiagnostics(stderr.String())
	}
	if ctx.Err() != nil { return ctx.Err() }
	if outputErr != nil { return fmt.Errorf("原生 ZMODEM 响应写入失败：%w", outputErr) }
	if processErr != nil {
		return fmt.Errorf("原生 ZMODEM sidecar 退出异常：%w；%s", processErr, stderr.String())
	}
	return nil
}

// Ensure that cancellable process coordination never needs to close or
// overwrite the shared SSH client/channel. Only dedicated local pipes close.
var _ io.Writer = nativeTerminalProtocolWriter{}
