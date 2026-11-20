package sshclient

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"time"
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
	rawToken, err := hex.DecodeString(registeredToken)
	if err != nil || len(rawToken) != 16 || hex.EncodeToString(rawToken) != registeredToken {
		return false, errors.New("缺少预先注册并验证的远端 Shell 会话标记")
	}
	if parent == nil || c == nil || c.input == nil || c.output == nil ||
		c.runner == nil || guard == nil {
		return false, errors.New("远端 ZMODEM 安全恢复参数不完整")
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
		return false, errors.New("不支持的 ZMODEM 方向")
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
		return false, fmt.Errorf("预注册 ZMODEM 握手交接失败（需重连）：%w", err)
	}
	var protocolErr error
	switch {
	default:
		select {
		case protocolErr = <-done:
		case protocolErr = <-sink.fail:
			_ = c.output.quarantineNative(lease)
			stopSidecar()
			return false, fmt.Errorf("远端协议字节转发失败（需重连）：%w", protocolErr)
		case <-ctx.Done():
			_, _ = c.input.writeNative(inputLease, zmodemCancelSequence)
			_ = c.output.quarantineNative(lease)
			stopSidecar()
			return false, fmt.Errorf("远端协议未完成（需重连）：%w", nativeZmodemContextError(ctx))
		}
	}
	// After Rust returns, the exit detector must remain active but it
	// must no longer forward any SSH output into Rust's closed pipe.
	if err := c.output.quarantineWithBoundary(lease, boundary); err != nil {
		stopSidecar()
		return false, fmt.Errorf("原生协议结束后输出隔离失败（需重连）：%w", err)
	}
	sink.finish(reader)
	if protocolErr != nil {
		return false, fmt.Errorf("Rust 协议执行失败，远端 Shell 未确认（需重连）：%w", protocolErr)
	}
	if !sink.seenHeader() {
		return false, errors.New("未收到远端 ZMODEM 握手（需重连）")
	}

	var remote nativeRemoteExit
	select {
	case remote = <-boundary.completion:
	case <-time.After(nativePassiveRemoteConfirmTimeout):
		_ = c.output.quarantineNative(lease)
		return false, errors.New("远端 Shell 未提供匹配会话标记（需重连）")
	case <-ctx.Done():
		_ = c.output.quarantineNative(lease)
		return false, fmt.Errorf("等待远端完成标记超时（需重连）：%w", nativeZmodemContextError(ctx))
	}
	if remote.err != nil {
		_ = c.output.quarantineNative(lease)
		return false, fmt.Errorf("远端完成标记无效（需重连）：%w", remote.err)
	}
	// Output first, manual stdin second: no typing can cross a half-restored
	// boundary. The guard's quarantine and scanner reset under output.mu.
	if err := c.output.restoreVerifiedPassive(lease, boundary, guard); err != nil {
		return false, fmt.Errorf("可信退出后恢复终端输出失败（需重连）：%w", err)
	}
	if err := c.input.restoreVerifiedPassive(inputLease); err != nil {
		return false, fmt.Errorf("可信退出后恢复终端输入失败（需重连）：%w", err)
	}
	if remote.code != 0 {
		return true, fmt.Errorf("远端 ZMODEM 退出码 %d，终端已恢复", remote.code)
	}
	if staging != "" {
		if err := nativeZmodemPublish(staging, publishTo); err != nil {
			return true, fmt.Errorf("原生文件接收完成但保存失败，终端已恢复：%w", err)
		}
	}
	return true, nil
}
