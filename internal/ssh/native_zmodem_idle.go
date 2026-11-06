package sshclient

import (
	"context"
	"errors"
	"sync/atomic"
	"time"
)

const nativeZmodemTransferIdleTimeout = 90 * time.Second

var errNativeZmodemIdleTimeout = errors.New("原生 ZMODEM 连续 90 秒无协议活动，传输已停止")

type nativeZmodemActivityKey struct{}

// newNativeZmodemIdleContext cancels only when protocol traffic stalls.
// A transfer that keeps exchanging bytes can run longer than the idle window.
// Parent cancellation remains authoritative, including disconnect and manual cancel.
func newNativeZmodemIdleContext(parent context.Context, idle time.Duration) (context.Context, context.CancelFunc, func()) {
	ctx, cancel := context.WithCancelCause(parent)
	var lastActivity atomic.Int64
	lastActivity.Store(time.Now().UnixNano())
	touch := func() { lastActivity.Store(time.Now().UnixNano()) }

	interval := idle / 4
	if interval > time.Second { interval = time.Second }
	if interval < time.Millisecond { interval = time.Millisecond }
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if time.Since(time.Unix(0, lastActivity.Load())) >= idle {
					cancel(errNativeZmodemIdleTimeout)
					return
				}
			}
		}
	}()
	ctx = context.WithValue(ctx, nativeZmodemActivityKey{}, touch)
	return ctx, func() { cancel(context.Canceled) }, touch
}

func nativeZmodemActivity(ctx context.Context) func() {
	if ctx == nil { return nil }
	touch, _ := ctx.Value(nativeZmodemActivityKey{}).(func())
	return touch
}

func nativeZmodemContextError(ctx context.Context) error {
	if ctx == nil { return nil }
	if cause := context.Cause(ctx); errors.Is(cause, errNativeZmodemIdleTimeout) {
		return cause
	}
	return ctx.Err()
}

type nativeZmodemActivityWriter struct {
	target ioWriter
	touch func()
}

type ioWriter interface { Write([]byte) (int, error) }

func (w nativeZmodemActivityWriter) Write(p []byte) (int, error) {
	n, err := w.target.Write(p)
	if n > 0 && w.touch != nil { w.touch() }
	return n, err
}
