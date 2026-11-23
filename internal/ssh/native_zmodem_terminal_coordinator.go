package sshclient

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/hctty27/openshell/internal/apperror"
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
			err := apperror.New("zmodemStartFrameMismatch", nil)
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
	started := time.Time{}
	if s.meter != nil { started = time.Now() }
	n, err := s.pipe.Write(p)
	if s.meter != nil { s.meter.recordFromRemote(n, time.Since(started)) }
	if n > 0 && s.activity != nil { s.activity() }
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
		return apperror.New("zmodemMissingContext", nil)
	}
	if err := parent.Err(); err != nil {
		return err
	}
	preparationStarted := time.Now()
	token, err := newNativeRemoteBoundaryToken()
	if err != nil { return apperror.Wrap("zmodemBoundaryTokenFailed", err, nil) }
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
			return apperror.Wrap("zmodemAbortedStartUnknown", cause, nil)
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
				return apperror.Wrap("zmodemAbortSendFailed", err, nil)
			}
			select {
			case remote = <-fence.completion:
				confirmed = true
			case <-time.After(2 * time.Second):
				return apperror.Wrap("zmodemAbortedExitUnknown", cause, nil)
			}
		}
		if !confirmed || remote.err != nil {
			return apperror.Wrap("zmodemAbortedStateUnknown", cause, nil)
		}
		if err := c.output.restoreWithReplay(outputLease, eraseThenReplay(fence.replayTrailing)); err != nil {
			return apperror.Wrap("zmodemRestoreOutputFailed", err, nil)
		}
		if err := c.input.restore(inputLease); err != nil {
			return apperror.Wrap("zmodemRestoreInputFailed", err, nil)
		}
		return apperror.Wrap("zmodemAbortedRecovered", cause, nil)
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
		return apperror.Wrap("zmodemStartFailedReconnect", err, nil)
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
			if remote.err != nil { return apperror.Wrap("zmodemBoundaryInvalidReconnect", remote.err, nil) }
			if err := c.output.restoreWithReplay(outputLease, eraseThenReplay(fence.replayTrailing)); err != nil { return err }
			if err := c.input.restore(inputLease); err != nil { return err }
			return zmodemRemoteDidNotStartError(remote.code, remotePath)
		}
		// A valid protocol did start, but its remote exit marker arrived
		// before the local sidecar finished. Bound the drain to avoid an
		// indefinitely busy shell after the remote command has exited.
		earlyCompletion = &remote
		select {
		case err = <-sidecarDone:
		case <-time.After(nativeZmodemShutdownTimeout):
			stopSidecar()
			if err := c.output.restoreWithReplay(outputLease, eraseThenReplay(fence.replayTrailing)); err != nil { return err }
			if err := c.input.restore(inputLease); err != nil { return err }
			return apperror.New("zmodemRemoteExitedEarly", nil)
		case <-ctx.Done():
			stopSidecar()
			return recoverInterrupted(nativeZmodemContextError(ctx))
		}
	case err = <-sink.fail:
		stopSidecar()
		return apperror.Wrap("zmodemForwardFailedReconnect", err, nil)
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
			if restoreErr := c.output.restoreWithReplay(outputLease, eraseThenReplay(fence.replayTrailing)); restoreErr != nil { return restoreErr }
			if restoreErr := c.input.restore(inputLease); restoreErr != nil { return restoreErr }
			return apperror.Wrap("zmodemSidecarFailedRecovered", err, nil)
		}
		return apperror.Wrap("zmodemSidecarFailedReconnect", err, nil)
	}
	if !sink.seenHeader() {
		return apperror.New("zmodemNoStartFrameReconnect", nil)
	}

	confirmationStarted := time.Now()
	// Local sidecar exit alone never grants permission to resume the terminal.
	// The remote shell emits a nonce-scoped OSC control marker *after* rz/sz
	// exits; the marker and following shell output do not reach the sidecar.
	// A nonzero exit code is a transfer failure, not evidence of an unsafe PTY:
	// the fenced marker still proves the remote command has terminated.
	remoteExitCode := 0
	if earlyCompletion != nil {
		if earlyCompletion.err != nil { return apperror.Wrap("zmodemBoundaryInvalidReconnect", earlyCompletion.err, nil) }
		remoteExitCode = earlyCompletion.code
	} else {
		select {
		case remote := <-fence.completion:
			if remote.err != nil { return apperror.Wrap("zmodemBoundaryInvalidReconnect", remote.err, nil) }
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
	if err := c.output.restoreWithReplay(outputLease, eraseThenReplay(fence.replayTrailing)); err != nil {
		return err
	}
	if err := c.input.restore(inputLease); err != nil {
		return err
	}
	if remoteExitCode != 0 {
		// Do not publish partially received downloads; preserve the remote
		// failure while keeping the verified, restored shell interactive.
		return apperror.New("zmodemRemoteExitStatus", map[string]any{"status": remoteExitCode})
	}
	if stage != "" {
		if err := nativeZmodemPublish(stage, publishDestination); err != nil {
			return apperror.Wrap("zmodemSaveFailed", err, nil)
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
