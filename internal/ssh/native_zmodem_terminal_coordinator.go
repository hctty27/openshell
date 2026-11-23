package sshclient

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
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

type nativeTerminalInboundSink struct {
	mu        sync.Mutex
	pipe      *io.PipeWriter
	ready     chan struct{}
	fail      chan error
	expected  byte
	meter     *nativeZmodemIOMeter
	activity func()
	activated bool
	finished  bool
}

// nativeTerminalInboundReader makes the sidecar's normal inbound.Close a
// lifecycle signal to the pipe writer. Without it, the sidecar can close its
// io.PipeReader when stdout ends before the coordinator notices completion,
// making harmless final SSH bytes look like an unexpected closed pipe.
type nativeTerminalInboundReader struct {
	reader *io.PipeReader
	sink *nativeTerminalInboundSink
}

func (r *nativeTerminalInboundReader) Read(p []byte) (int, error) {
	return r.reader.Read(p)
}

func (r *nativeTerminalInboundReader) Close() error {
	r.sink.finish(r.reader)
	return nil
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
			s.finished = true
			select {
			case s.fail <- err:
			default:
			}
			s.mu.Unlock()
			// A protocol error must not escape into ssh.Session's stdout
			// copier, which could tear down an otherwise live terminal.
			// The coordinator receives the failure while the output gate
			// continues to quarantine every subsequent protocol byte.
			return len(p), nil
		}
		s.activated = true
		close(s.ready)
	}
	s.mu.Unlock()
	started := time.Time{}
	if s.meter != nil { started = time.Now() }
	n, err := s.pipe.Write(p)
	if s.meter != nil { s.meter.recordFromRemote(n, time.Since(started)) }
	if n > 0 && s.activity != nil { s.activity() }
	if err != nil {
		s.mu.Lock()
		finished := s.finished
		if !finished {
			s.finished = true
		}
		s.mu.Unlock()
		// Rust may close its dedicated inbound pipe while SSH stdout is
		// still delivering bytes. Never propagate a local pipe failure to
		// ssh.Session's stdout copier: doing so can terminate the terminal
		// even though the SSH transport and remote Shell are still alive.
		// Failure is reported to the coordinator, which keeps the PTY
		// isolated until a separately verified remote completion boundary.
		if !finished {
			select {
			case s.fail <- err:
			default:
			}
		}
		return len(p), nil
	}
	return n, nil
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
	meter *nativeZmodemIOMeter
	activity func()
}

func (w *nativeTerminalOutboundBarrier) Write(p []byte) (int, error) {
	readyStarted := time.Time{}
	if w.meter != nil { readyStarted = time.Now() }
	select {
	case <-w.ctx.Done():
		return 0, w.ctx.Err()
	case <-w.ready:
	}
	if w.meter != nil { w.meter.recordReadyWait(time.Since(readyStarted)) }
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	started := time.Time{}
	if w.meter != nil { started = time.Now() }
	n, err := w.input.writeNative(w.lease, p)
	if n > 0 && w.activity != nil { w.activity() }
	if w.meter != nil { w.meter.recordToRemote(n, time.Since(started)) }
	return n, err
}

// run performs an explicitly initiated, single-file transfer in the existing
// SSH terminal. A fresh nonce-bound OSC marker is emitted only after the
// invoked remote rz/sz process returns. No UI or production entrypoint calls
// this experimental method yet.
//
// If an error occurs after the command is sent, the existing PTY is not
// recoverable without independent remote completion proof. In that case the
// gates stay exclusively owned until the whole terminal disconnects.
// Single-file interactive PTY transfer. The transport and cancellation gates
// are unchanged; batch manifests are not part of the runtime path.
func (c *nativeTerminalCoordinator) run(
	parent context.Context, direction, localPath, remotePath string,
) error {
	if parent == nil || c == nil || c.input == nil || c.output == nil || c.runner == nil {
		return errors.New("缺少原生终端传输协调参数")
	}
	if err := parent.Err(); err != nil {
		return err
	}
	preparationStarted := time.Now()
	token, err := newNativeRemoteBoundaryToken()
	if err != nil { return fmt.Errorf("远端传输结束令牌创建失败：%w", err) }
	command, action, err := nativeInteractiveFencedCommand(direction, remotePath, token)
	if err != nil { return err }

	var path string
	if action == "send" {
		path, err = nativeZmodemLocalPath("upload", localPath)
	} else {
		path, err = nativeZmodemLocalPath("download", localPath)
	}
	if err != nil { return err }
	publishDestination := path
	stage := ""
	if action == "receive" {
		stage, err = os.MkdirTemp(path, ".openshell-zmodem-terminal-")
		if err != nil { return err }
		defer os.RemoveAll(stage)
		path = stage
	}

	ctx, cancel, activity := newNativeZmodemIdleContext(parent, nativeZmodemTransferIdleTimeout)
	defer cancel()
	inputLease, err := c.input.takeover()
	if err != nil {
		return err
	}

	reader, writer := io.Pipe()
	meter := nativeZmodemIOMeterFromContext(parent)
	expected := byte('1') // remote rz starts with ZRINIT
	if action == "receive" {
		expected = '0' // remote sz starts with ZRQINIT
	}
	sink := &nativeTerminalInboundSink{
		pipe: writer, ready: make(chan struct{}), fail: make(chan error, 1), expected: expected, meter: meter, activity: activity,
	}
	fence := newNativeRemoteBoundarySink(sink, token)
	outputLease, err := c.output.armOnZmodemHeaderQuietBoundary(fence, fence.prefix)
	if err != nil {
		_ = reader.Close()
		_ = writer.Close()
		_ = c.input.restore(inputLease)
		return err
	}

	// The child may write its initial handshake immediately; it is held
	// until a matching *remote* start header has been captured in full.
	outbound := &nativeTerminalOutboundBarrier{
		ctx: ctx, ready: sink.ready, input: c.input, lease: inputLease, meter: meter, activity: activity,
	}
	sidecarDone := make(chan error, 1)
	go func() {
		sidecarDone <- c.runner(ctx, action, path, &nativeTerminalInboundReader{reader: reader, sink: sink}, outbound)
	}()

	stopSidecar := func() {
		cancel()
		sink.finish(reader)
		select {
		case <-sidecarDone:
		case <-time.After(nativeZmodemShutdownTimeout):
		}
	}
	// Restore on cancellation only after the exact remote shell command has
	// exited. Sidecar termination and byte counts alone are not proof. The
	// output gate continues discarding binary tail bytes until that marker.
	recoverInterrupted := func(cause error) error {
		if cause == nil { cause = context.Canceled }
		if !sink.seenHeader() {
			return fmt.Errorf("原生 ZMODEM 已中止，但未确认远端协议启动（需重连）：%w", cause)
		}
		var remote nativeRemoteExit
		var confirmed bool
		select {
		case remote = <-fence.completion:
			confirmed = true
		default:
		}
		if !confirmed {
			// ZMODEM cancel (CAN + backspace), not an ordinary shell Ctrl+C.
			// Only send it after the remote ZMODEM header has been recognized.
			if _, err := c.input.writeNative(inputLease, zmodemCancelSequence); err != nil {
				return fmt.Errorf("原生 ZMODEM 中止通知发送失败（需重连）：%w", err)
			}
			select {
			case remote = <-fence.completion:
				confirmed = true
			case <-time.After(2 * time.Second):
				return fmt.Errorf("原生 ZMODEM 已中止，但远端未确认退出（需重连）：%w", cause)
			}
		}
		if !confirmed || remote.err != nil {
			return fmt.Errorf("原生 ZMODEM 已中止，远端状态不确定（需重连）：%w", cause)
		}
		if err := c.output.restoreWithReplay(outputLease, fence.replayTrailing); err != nil {
			return fmt.Errorf("远端已退出，但恢复终端输出失败（需重连）：%w", err)
		}
		if err := c.input.restore(inputLease); err != nil {
			return fmt.Errorf("远端已退出，但恢复终端输入失败（需重连）：%w", err)
		}
		return fmt.Errorf("原生 ZMODEM 已中止，终端已安全恢复：%w", cause)
	}
	// Start the remote command only after both ownership leases are held
	// and the local sidecar reader has been launched.
	n, err := c.input.writeNative(inputLease, []byte(command))
	if n > 0 { activity() }
	if err != nil || n != len(command) {
		stopSidecar()
		if err == nil {
			err = io.ErrShortWrite
		}
		return fmt.Errorf("启动远端原生 ZMODEM 失败（需要重连终端）：%w", err)
	}

	observeNativeZmodemStage(parent, "prepare", preparationStarted)
	protocolStarted := time.Now()
	var earlyCompletion *nativeRemoteExit
	select {
	case err = <-sidecarDone:
		// The remote shell may still be emitting binary protocol data.
		// Do not restore without a verified per-transfer completion marker.
	case remote := <-fence.completion:
		if !sink.seenHeader() {
			// A remote sz for a missing file (or missing lrzsz) terminates
			// before ZMODEM ever starts. Reap the still-waiting local sidecar,
			// and restore only because the nonce-scoped shell fence was seen.
			stopSidecar()
			if remote.err != nil { return fmt.Errorf("远端 ZMODEM 结束标记异常（需要重连）：%w", remote.err) }
			if err := c.output.restoreWithReplay(outputLease, fence.replayTrailing); err != nil { return err }
			if err := c.input.restore(inputLease); err != nil { return err }
			return fmt.Errorf("远端 rz/sz 未能启动 ZMODEM 协议（退出状态 %d），终端已安全恢复", remote.code)
		}
		// A valid protocol did start, but its remote exit marker arrived
		// before the local sidecar finished. Bound the drain to avoid an
		// indefinitely busy shell after the remote command has exited.
		earlyCompletion = &remote
		select {
		case err = <-sidecarDone:
		case <-time.After(nativeZmodemShutdownTimeout):
			stopSidecar()
			if err := c.output.restoreWithReplay(outputLease, fence.replayTrailing); err != nil { return err }
			if err := c.input.restore(inputLease); err != nil { return err }
			return errors.New("远端 rz/sz 已退出，但本地协议处理未结束；终端已安全恢复")
		case <-ctx.Done():
			stopSidecar()
			return recoverInterrupted(nativeZmodemContextError(ctx))
		}
	case err = <-sink.fail:
		stopSidecar()
		return fmt.Errorf("原生 ZMODEM 启动或转发失败（需要重连终端）：%w", err)
	case <-ctx.Done():
		stopSidecar()
		return recoverInterrupted(nativeZmodemContextError(ctx))
	}
	observeNativeZmodemStage(parent, "protocol", protocolStarted)
	sink.finish(reader)
	if err != nil {
		if cause := nativeZmodemContextError(ctx); cause != nil {
			return recoverInterrupted(cause)
		}
		// Even if the protocol process failed, a verified remote exit
		// means no binary data can still arrive at this terminal.
		if earlyCompletion != nil && earlyCompletion.err == nil {
			if restoreErr := c.output.restoreWithReplay(outputLease, fence.replayTrailing); restoreErr != nil { return restoreErr }
			if restoreErr := c.input.restore(inputLease); restoreErr != nil { return restoreErr }
			return fmt.Errorf("原生 ZMODEM sidecar 执行失败，终端已安全恢复：%w", err)
		}
		return fmt.Errorf("原生 ZMODEM sidecar 执行失败（需要重连终端）：%w", err)
	}
	if !sink.seenHeader() {
		return errors.New("未收到远程 ZMODEM 启动帧，终端状态不可确认（需要重连）")
	}

	confirmationStarted := time.Now()
	// Local sidecar exit alone never grants permission to resume the terminal.
	// The remote shell emits a nonce-scoped OSC control marker *after* rz/sz
	// exits; the marker and following shell output do not reach the sidecar.
	// A nonzero exit code is a transfer failure, not evidence of an unsafe PTY:
	// the fenced marker still proves the remote command has terminated.
	remoteExitCode := 0
	if earlyCompletion != nil {
		if earlyCompletion.err != nil { return fmt.Errorf("远端 ZMODEM 结束标记异常（需要重连）：%w", earlyCompletion.err) }
		remoteExitCode = earlyCompletion.code
	} else {
		select {
		case remote := <-fence.completion:
			if remote.err != nil { return fmt.Errorf("远端 ZMODEM 结束标记异常（需要重连）：%w", remote.err) }
			remoteExitCode = remote.code
		case <-ctx.Done():
			return recoverInterrupted(nativeZmodemContextError(ctx))
		}
	}
	if ctxErr := nativeZmodemContextError(ctx); ctxErr != nil { return ctxErr }

	observeNativeZmodemStage(parent, "remoteConfirm", confirmationStarted)
	restoreStarted := time.Now()
	// Replay bytes received after the completion marker while holding the
	// output gate lock, before admitting any new ordinary SSH output.
	if err := c.output.restoreWithReplay(outputLease, fence.replayTrailing); err != nil {
		return err
	}
	if err := c.input.restore(inputLease); err != nil {
		return err
	}
	if remoteExitCode != 0 {
		// Do not publish partially received downloads; preserve the remote
		// failure while keeping the verified, restored shell interactive.
		return fmt.Errorf("远端 rz/sz 退出状态为 %d，终端已安全恢复", remoteExitCode)
	}
	if stage != "" {
		if err := nativeZmodemPublish(stage, publishDestination); err != nil {
			return fmt.Errorf("原生 ZMODEM 接收成功，但保存文件失败：%w", err)
		}
	}
	observeNativeZmodemStage(parent, "restorePublish", restoreStarted)
	return nil
}

// compile-time signature check for the executable sidecar runner wrapper.
func nativeTerminalExecutableRunner(executable string) nativeTerminalSidecarRunner {
	return nativeTerminalExecutableRunnerWithProgress(executable, nil)
}

func nativeTerminalExecutableRunnerWithProgress(executable string, progress func(uint64, uint64)) nativeTerminalSidecarRunner {
	return func(ctx context.Context, direction, path string, in io.ReadCloser, out io.Writer) error {
		return runNativeZmodemTerminalSidecarWithProgress(ctx, executable, direction, filepath.Clean(path), in, out, progress)
	}
}
