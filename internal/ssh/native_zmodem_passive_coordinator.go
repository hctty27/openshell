package sshclient

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"
)

// runPassive connects an already-running remote rz/sz process to the Rust
// engine. It must never write a second rz/sz shell command into the PTY.
//
// Unlike the explicitly fenced path, no per-command remote exit token exists.
// Consequently this method NEVER restores the SSH input/output leases. Even a
// successful protocol completion leaves the terminal unusable until reconnect.
func (c *nativeTerminalCoordinator) runPassive(
	parent context.Context, direction, localPath string,
	guard *nativeOnlyOutputGuard,
) error {
	if parent == nil || c == nil || c.input == nil || c.output == nil ||
		c.runner == nil || guard == nil {
		return errors.New("远端 ZMODEM 自动接管参数不完整")
	}
	if err := parent.Err(); err != nil { return err }
	action := ""
	expected := byte('0')
	switch direction {
	case "upload":
		action, expected = "send", '1'
	case "download":
		action, expected = "receive", '0'
	default:
		return errors.New("不支持的远端 ZMODEM 自动传输方向")
	}
	path, err := nativeZmodemLocalPath(direction, localPath)
	if err != nil { return err }
	stage := ""
	publishTo := path
	if action == "receive" {
		stage, err = os.MkdirTemp(path, ".openshell-zmodem-passive-")
		if err != nil { return err }
		defer os.RemoveAll(stage)
		path = stage
	}
	ctx, cancel, activity := newNativeZmodemIdleContext(parent, nativeZmodemTransferIdleTimeout)
	defer cancel()
	inputLease, err := c.input.takeover()
	if err != nil { return err }
	reader, writer := io.Pipe()
	sink := &nativeTerminalInboundSink{
		pipe: writer, ready: make(chan struct{}), fail: make(chan error, 1),
		expected: expected, meter: nativeZmodemIOMeterFromContext(parent), activity: activity,
	}
	outbound := &nativeTerminalOutboundBarrier{
		ctx: ctx, ready: sink.ready, input: c.input, lease: inputLease,
		meter: sink.meter, activity: activity,
	}
	sidecarDone := make(chan error, 1)
	go func() {
		sidecarDone <- c.runner(ctx, action, path,
			&nativeTerminalInboundReader{reader: reader, sink: sink}, outbound)
	}()
	stopSidecar := func() {
		cancel()
		sink.finish(reader)
		select {
		case <-sidecarDone:
		case <-time.After(nativeZmodemShutdownTimeout):
		}
	}
	protocolStarted := time.Now()
	// The output gate orders all captured bytes before fresh SSH output
	// while Rust is already reading its dedicated pipe.
	outputLease, err := c.output.takeoverCaptured(sink, guard)
	if err != nil {
		// The gate may have already switched to the Rust pipe before the
		// initial buffered Write failed. Keep it quarantined on this path.
		if outputLease != 0 { _ = c.output.quarantineNative(outputLease) }
		stopSidecar()
		return fmt.Errorf("远端 ZMODEM 初始握手交接失败（需重连）：%w", err)
	}
	var processErr error
	abort, cancelled := false, false
	select {
	case processErr = <-sidecarDone:
	case processErr = <-sink.fail:
		// A broken SSH-to-Rust pipe is a real failure, regardless of how
		// the Rust process exits after cancellation.
		abort = true
	case <-ctx.Done():
		// Only ZMODEM CAN may be sent; user Ctrl+C is never forwarded.
		_, _ = c.input.writeNative(inputLease, zmodemCancelSequence)
		abort, cancelled = true, true
	}
	// Preserve the output lease but detach the Rust pipe before closing it.
	// Follow-up PTY output must not reach xterm or a closed pipe while the
	// remote Shell's command-completion boundary remains unverified.
	quarantineErr := c.output.quarantineNative(outputLease)
	if abort {
		stopSidecar()
	} else {
		sink.finish(reader)
	}
	if cancelled {
		return fmt.Errorf("远端 ZMODEM 自动传输已中止，终端需重连：%w", nativeZmodemContextError(ctx))
	}
	if quarantineErr != nil {
		return fmt.Errorf("无法安全隔离远端 ZMODEM 结束后的输出（需重连）：%w", quarantineErr)
	}
	observeNativeZmodemStage(parent, "protocol", protocolStarted)
	if processErr != nil {
		if cause := nativeZmodemContextError(ctx); cause != nil {
			return fmt.Errorf("远端 ZMODEM 自动传输失败，终端需重连：%w", cause)
		}
		return fmt.Errorf("远端 ZMODEM 自动传输失败，终端需重连：%w", processErr)
	}
	if !sink.seenHeader() {
		return errors.New("未收到有效远端 ZMODEM 起始帧，终端需重连")
	}
	if stage != "" {
		if err := nativeZmodemPublish(stage, publishTo); err != nil {
			return fmt.Errorf("远端 ZMODEM 接收完成但保存文件失败，终端需重连：%w", err)
		}
	}
	// Receiving a complete ZFIN is protocol-level success, not shell exit
	// proof. The manager permanently poisons this PTY before returning.
	return nil
}

