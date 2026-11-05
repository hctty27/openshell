package sshclient

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// nativeTerminalSidecarRunner isolates the protocol process from the SSH
// terminal itself. The executable implementation is
// runNativeZmodemTerminalSidecar; tests use a deterministic in-memory peer.
type nativeTerminalSidecarRunner func(context.Context, string, string, io.ReadCloser, io.Writer) error

// nativeTerminalCoordinator is an experiment-only bridge between the already
// present input and output gates. It is NOT wired into the Wails application.
// A per-transfer shell completion marker is detected behind the output gate;
// the old terminal stays isolated on any unconfirmed or failed transfer.
type nativeTerminalCoordinator struct {
	input  *terminalInputGate
	output *terminalOutputGate
	runner nativeTerminalSidecarRunner
}

func nativeInteractiveCommand(direction, remotePath string) (string, string, error) {
	switch direction {
	case "upload":
		// Existing interactive shell cwd is the destination. Unlike the
		// independent SSH exec bridge, we must not exec away the login shell.
		return "rz -q\r", "send", nil
	case "download":
		if remotePath == "" || strings.IndexFunc(remotePath, func(r rune) bool {
			return r < 32 || r == 127
		}) >= 0 {
			return "", "", errors.New("下载文件的远程路径无效")
		}
		quoted := "'" + strings.ReplaceAll(remotePath, "'", "'\\''") + "'"
		return "sz -q -- " + quoted + "\r", "receive", nil
	default:
		return "", "", fmt.Errorf("不支持的原生 ZMODEM 方向：%s", direction)
	}
}

type nativeTerminalInboundSink struct {
	mu        sync.Mutex
	pipe      *io.PipeWriter
	ready     chan struct{}
	fail      chan error
	expected  byte
	activated bool
	finished  bool
}

func (s *nativeTerminalInboundSink) Write(p []byte) (int, error) {
	s.mu.Lock()
	if s.finished {
		s.mu.Unlock()
		return len(p), nil // never fall back to the visible terminal
	}
	if !s.activated {
		if len(p) < nativeZmodemHeaderSize || p[5] != s.expected {
			err := errors.New("远端 ZMODEM 启动帧方向不匹配，已禁止终端自动回退")
			select {
			case s.fail <- err:
			default:
			}
			s.mu.Unlock()
			return 0, err
		}
		s.activated = true
		close(s.ready)
	}
	s.mu.Unlock()
	n, err := s.pipe.Write(p)
	if err != nil {
		s.mu.Lock()
		finished := s.finished
		s.mu.Unlock()
		// The Rust sidecar may finish immediately after it consumes the
		// final control frame, while the SSH stdout goroutine still holds
		// one in-flight pipe.Write. Closing that dedicated reader to clean
		// up must not turn a successful transfer into a fatal SSH writer
		// error. The output gate continues to own subsequent bytes; none
		// are allowed to fall back into the visible terminal.
		if finished && errors.Is(err, io.ErrClosedPipe) {
			return len(p), nil
		}
		select {
		case s.fail <- err:
		default:
		}
	}
	return n, err
}

func (s *nativeTerminalInboundSink) seenHeader() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.activated
}

func (s *nativeTerminalInboundSink) finish(reader *io.PipeReader) {
	s.mu.Lock()
	s.finished = true
	s.mu.Unlock()
	_ = reader.Close()
	_ = s.pipe.Close()
}

type nativeTerminalOutboundBarrier struct {
	ctx   context.Context
	ready <-chan struct{}
	input *terminalInputGate
	lease uint64
}

func (w *nativeTerminalOutboundBarrier) Write(p []byte) (int, error) {
	select {
	case <-w.ctx.Done():
		return 0, w.ctx.Err()
	case <-w.ready:
	}
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	return w.input.writeNative(w.lease, p)
}

// run performs an explicitly initiated, single-file transfer in the existing
// SSH terminal. A fresh nonce-bound OSC marker is emitted only after the
// invoked remote rz/sz process returns. No UI or production entrypoint calls
// this experimental method yet.
//
// If an error occurs after the command is sent, the existing PTY is not
// recoverable without independent remote completion proof. In that case the
// gates stay exclusively owned until the whole terminal disconnects.
func (c *nativeTerminalCoordinator) run(
	parent context.Context,
	direction, localPath, remotePath string,
) error {
	if parent == nil || c == nil || c.input == nil || c.output == nil || c.runner == nil {
		return errors.New("缺少原生终端传输协调参数")
	}
	if err := parent.Err(); err != nil {
		return err
	}
	token, err := newNativeRemoteBoundaryToken()
	if err != nil { return fmt.Errorf("远端传输结束令牌创建失败：%w", err) }
	command, action, err := nativeInteractiveFencedCommand(direction, remotePath, token)
	if err != nil {
		return err
	}
	path, err := nativeZmodemLocalPath(direction, localPath)
	if err != nil {
		return err
	}
	publishDestination := path
	stage := ""
	if action == "receive" {
		stage, err = os.MkdirTemp(path, ".openshell-zmodem-terminal-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(stage)
		path = stage
	}

	ctx, cancel := context.WithTimeout(parent, nativeZmodemTransferTimeout)
	defer cancel()
	inputLease, err := c.input.takeover()
	if err != nil {
		return err
	}

	reader, writer := io.Pipe()
	expected := byte('1') // remote rz starts with ZRINIT
	if action == "receive" {
		expected = '0' // remote sz starts with ZRQINIT
	}
	sink := &nativeTerminalInboundSink{
		pipe: writer, ready: make(chan struct{}), fail: make(chan error, 1), expected: expected,
	}
	fence := newNativeRemoteBoundarySink(sink, token)
	outputLease, err := c.output.armOnZmodemHeader(fence)
	if err != nil {
		_ = reader.Close()
		_ = writer.Close()
		_ = c.input.restore(inputLease)
		return err
	}

	// The child may write its initial handshake immediately; it is held
	// until a matching *remote* start header has been captured in full.
	outbound := &nativeTerminalOutboundBarrier{
		ctx: ctx, ready: sink.ready, input: c.input, lease: inputLease,
	}
	sidecarDone := make(chan error, 1)
	go func() {
		sidecarDone <- c.runner(ctx, action, path, reader, outbound)
	}()

	stopSidecar := func() {
		cancel()
		sink.finish(reader)
		select {
		case <-sidecarDone:
		case <-time.After(nativeZmodemShutdownTimeout):
		}
	}
	// Start the remote command only after both ownership leases are held
	// and the local sidecar reader has been launched.
	n, err := c.input.writeNative(inputLease, []byte(command))
	if err != nil || n != len(command) {
		stopSidecar()
		if err == nil {
			err = io.ErrShortWrite
		}
		return fmt.Errorf("启动远端原生 ZMODEM 失败（需要重连终端）：%w", err)
	}

	select {
	case err = <-sidecarDone:
		// Any sidecar error is fail-closed; the remote shell may still be
		// emitting binary data. No automatic disarm or legacy restoration.
	case err = <-sink.fail:
		stopSidecar()
		return fmt.Errorf("原生 ZMODEM 启动或转发失败（需要重连终端）：%w", err)
	case <-ctx.Done():
		stopSidecar()
		return fmt.Errorf("原生 ZMODEM 已取消或超时（需要重连终端）：%w", ctx.Err())
	}
	sink.finish(reader)
	if err != nil {
		return fmt.Errorf("原生 ZMODEM sidecar 执行失败（需要重连终端）：%w", err)
	}
	if !sink.seenHeader() {
		return errors.New("未收到远程 ZMODEM 启动帧，终端状态不可确认（需要重连）")
	}

	// Local sidecar exit alone never grants permission to resume the terminal.
	// The remote shell emits a nonce-scoped OSC control marker *after* rz/sz
	// exits; the marker and following shell output do not reach the sidecar.
	select {
	case remote := <-fence.completion:
		if remote.err != nil { return fmt.Errorf("远端 ZMODEM 结束标记异常（需要重连）：%w", remote.err) }
		if remote.code != 0 { return fmt.Errorf("远端 rz/sz 退出状态为 %d，终端需要重连", remote.code) }
		if ctxErr := ctx.Err(); ctxErr != nil { return ctxErr }
	case <-ctx.Done():
		return fmt.Errorf("等待远端传输结束标记超时（需要重连终端）：%w", ctx.Err())
	}

	// Replay bytes received after the completion marker while holding the
	// output gate lock, before admitting any new ordinary SSH output.
	if err := c.output.restoreWithReplay(outputLease, fence.replayTrailing); err != nil {
		return err
	}
	if err := c.input.restore(inputLease); err != nil {
		return err
	}
	if stage != "" {
		if err := nativeZmodemPublish(stage, publishDestination); err != nil {
			return fmt.Errorf("原生 ZMODEM 接收成功，但保存文件失败：%w", err)
		}
	}
	return nil
}

// compile-time signature check for the executable sidecar runner wrapper.
func nativeTerminalExecutableRunner(executable string) nativeTerminalSidecarRunner {
	return func(ctx context.Context, direction, path string, in io.ReadCloser, out io.Writer) error {
		return runNativeZmodemTerminalSidecar(ctx, executable, direction, filepath.Clean(path), in, out)
	}
}
