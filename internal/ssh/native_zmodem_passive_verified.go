package sshclient

import (
	"context"
	"encoding/hex"
	"io"
	"os"
	"time"

	"github.com/hctty27/openshell/internal/apperror"
)

// nativePassiveRemoteConfirmTimeout applies only after Rust reports complete.
// An unverified or absent Bash command-finished marker must never resume PTY.
const nativePassiveRemoteConfirmTimeout = 5 * time.Second

// runPassiveVerified is the second-stage, opt-in coordinator for an ALREADY
// REGISTERED remote Bash prompt hook. The session token is established before
// the remote rz/sz command begins and MUST NOT be sent as part of its output.
//
// This method is deliberately NOT called by the current normal/passive UI:
// installing and acknowledging the prompt hook on the exact SSH shell is a
// separate prerequisite. Until that installation is proven, runPassive stays
// fail-closed and requires an SSH reconnect.
func (c *nativeTerminalCoordinator) runPassiveVerified(
	parent context.Context, direction, localPath string,
	guard *nativeOnlyOutputGuard, registeredToken string,
) (restored bool, resultErr error) {
	if !nativePassiveTokenValid(registeredToken) {
		return false, apperror.New("zmodemPassiveMarkerMissing", nil)
	}
	if parent == nil || c == nil || c.input == nil || c.output == nil ||
		c.runner == nil || guard == nil {
		return false, apperror.New("zmodemPassiveRecoveryIncomplete", nil)
	}
	if err := parent.Err(); err != nil { return false, err }

	var action string
	expected := byte('0')
	switch direction {
	case "upload":
		action, expected = "send", '1'
	case "download":
		action, expected = "receive", '0'
	default:
		return false, apperror.New("zmodemUnsupportedDirection", nil)
	}
	path, err := nativeZmodemLocalPath(direction, localPath)
	if err != nil { return false, err }
	publishTo := path
	staging := ""
	if action == "receive" {
		staging, err = os.MkdirTemp(path, ".openshell-zmodem-verified-")
		if err != nil { return false, err }
		defer os.RemoveAll(staging)
		path = staging
	}

	ctx, cancel, activity := newNativeZmodemIdleContext(parent, nativeZmodemTransferIdleTimeout)
	defer cancel()
	inputLease, err := c.input.takeover()
	if err != nil { return false, err }
	reader, writer := io.Pipe()
	sink := &nativeTerminalInboundSink{
		pipe: writer, ready: make(chan struct{}), fail: make(chan error, 1),
		expected: expected, meter: nativeZmodemIOMeterFromContext(parent), activity: activity,
	}
	boundary := newNativeRemoteBoundarySink(sink, registeredToken)
	outbound := &nativeTerminalOutboundBarrier{
		ctx: ctx, ready: sink.ready, input: c.input, lease: inputLease,
		meter: sink.meter, activity: activity,
	}
	done := make(chan error, 1)
	go func() {
		result := c.runner(ctx, action, path, &nativeTerminalInboundReader{
			reader: reader, sink: sink,
		}, outbound)
		// Unblock an in-flight SSH→Rust Pipe.Write before publishing the
		// sidecar completion. Without this ordering, the output gate can
		// wait for a Write whose reader has already exited.
		sink.finish(reader)
		done <- result
	}()
	stopSidecar := func() {
		cancel()
		sink.finish(reader)
		select {
		case <-done:
		case <-time.After(nativeZmodemShutdownTimeout):
		}
	}

	// Deliver the captured ZHEX start first; later SSH bytes cannot overtake
	// it because takeoverCaptured holds the output gate's mutex.
	lease, err := c.output.takeoverCaptured(boundary, guard)
	if err != nil {
		if lease != 0 { _ = c.output.quarantineNative(lease) }
		stopSidecar()
		return false, apperror.Wrap("zmodemHandshakeFailedReconnect", err, nil)
	}
	var protocolErr error
	select {
	case protocolErr = <-done:
	case protocolErr = <-sink.fail:
		stopSidecar()
	case <-ctx.Done():
		protocolErr = nativeZmodemContextError(ctx)
		stopSidecar()
	}
	// After Rust returns, the exit detector must remain active but it
	// must no longer forward any SSH output into Rust's closed pipe.
	if err := c.output.quarantineWithBoundary(lease, boundary); err != nil {
		stopSidecar()
		return false, apperror.Wrap("zmodemOutputIsolationFailed", err, nil)
	}
	sink.finish(reader)
	if protocolErr != nil {
		// Do not publish a partial download. A failed Rust task can still
		// return to the original shell when its Bash exit marker is proven.
		if c.recoverPassiveAbort(context.WithoutCancel(parent), inputLease, lease, boundary, guard) {
			return true, protocolErr
		}
		return false, apperror.Wrap("zmodemSidecarFailedReconnect", protocolErr, nil)
	}
	if !sink.seenHeader() {
		return false, apperror.New("zmodemNoStartFrameReconnect", nil)
	}

	// Rust has received or sent the whole file at this point (lengths and
	// CRCs checked). If the remote shell does not confirm its return - a
	// nested shell (bash -l, sudo -i, su -, vim :!) never prints our marker
	// - the file is still kept; only the terminal needs a reconnect.
	keepFile := func() (bool, error) {
		_ = c.output.quarantineNative(lease)
		if staging != "" {
			if err := nativeZmodemPublish(staging, publishTo); err != nil {
				return false, apperror.Wrap("zmodemSaveFailed", err, nil)
			}
		}
		return false, nil
	}
	var remote nativeRemoteExit
	select {
	case remote = <-boundary.completion:
	case <-time.After(nativePassiveRemoteConfirmTimeout):
		return keepFile()
	case <-ctx.Done():
		return keepFile()
	}
	if remote.err != nil {
		return keepFile()
	}
	// Output first, manual stdin second: no typing can cross a half-restored
	// boundary. The guard's quarantine and scanner reset under output.mu.
	if err := c.output.restoreVerifiedPassive(lease, boundary, guard); err != nil {
		return false, apperror.Wrap("zmodemRestoreOutputFailed", err, nil)
	}
	if err := c.input.restoreVerifiedPassive(inputLease); err != nil {
		return false, apperror.Wrap("zmodemRestoreInputFailed", err, nil)
	}
	if remote.code != 0 {
		return true, apperror.New("zmodemRemoteExitStatus", map[string]any{"status": remote.code})
	}
	if staging != "" {
		if err := nativeZmodemPublish(staging, publishTo); err != nil {
			return true, apperror.Wrap("zmodemSaveFailed", err, nil)
		}
	}
	return true, nil
}

// nativePassiveTokenValid accepts only the nonce format installed by the Bash
// hook before the remote command was started.
func nativePassiveTokenValid(token string) bool {
	raw, err := hex.DecodeString(token)
	return err == nil && len(raw) == 16 && hex.EncodeToString(raw) == token
}

// recoverPassiveAbort operates only on an already-claimed output boundary,
// after the Rust reader (if any) has stopped. Cancel only if no matching
// completion marker was already captured. Never restore on CAN, a prompt,
// a timer, or local sidecar exit alone.
func (c *nativeTerminalCoordinator) recoverPassiveAbort(
	ctx context.Context, inputLease, outputLease uint64,
	boundary *nativeRemoteBoundarySink, guard *nativeOnlyOutputGuard,
) bool {
	var remote nativeRemoteExit
	select {
	case remote = <-boundary.completion:
	default:
		if ctx.Err() != nil {
			_ = c.output.quarantineNative(outputLease)
			return false
		}
		n, err := c.input.writeNative(inputLease, zmodemCancelSequence)
		if err != nil || n != len(zmodemCancelSequence) {
			_ = c.output.quarantineNative(outputLease)
			return false
		}
		timer := time.NewTimer(nativePassiveRemoteConfirmTimeout)
		defer timer.Stop()
		select {
		case remote = <-boundary.completion:
		case <-timer.C:
			_ = c.output.quarantineNative(outputLease)
			return false
		case <-ctx.Done():
			_ = c.output.quarantineNative(outputLease)
			return false
		}
	}
	if remote.err != nil || ctx.Err() != nil {
		_ = c.output.quarantineNative(outputLease)
		return false
	}
	// Nonzero remote status is expected on abort; the caller still reports
	// cancellation/failure. Only the verified exit grants permission to type.
	if err := c.output.restoreVerifiedPassive(outputLease, boundary, guard); err != nil {
		return false
	}
	return c.input.restoreVerifiedPassive(inputLease) == nil
}

// cancelPassivePicker consumes an already-started, CRC-validated handshake
// without launching a sidecar or touching a local file.
func (c *nativeTerminalCoordinator) cancelPassivePicker(
	ctx context.Context, guard *nativeOnlyOutputGuard, token string,
) bool {
	if ctx == nil || ctx.Err() != nil || !nativePassiveTokenValid(token) {
		return false
	}
	inputLease, err := c.input.takeover()
	if err != nil { return false }
	boundary := newNativeRemoteBoundarySink(io.Discard, token)
	outputLease, err := c.output.takeoverCaptured(boundary, guard)
	if err != nil {
		if outputLease != 0 { _ = c.output.quarantineNative(outputLease) }
		return false
	}
	return c.recoverPassiveAbort(ctx, inputLease, outputLease, boundary, guard)
}
