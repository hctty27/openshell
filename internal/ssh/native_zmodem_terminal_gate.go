package sshclient

import (
	"errors"
	"io"
	"sync"
)

var (
	errTerminalStreamOwned = errors.New("终端输出已由另一项传输独占")
	errTerminalStreamLease = errors.New("终端输出独占令牌已失效")
)

// terminalOutputGate serializes access to one SSH terminal output stream.
// Legacy trzsz is the unconditional default until an explicit opt-in arm.
// Neither the application nor production UI currently calls armOnZmodemHeader.
type terminalOutputGate struct {
	mu      sync.Mutex
	legacy  io.Writer
	native  io.Writer
	armed   io.Writer
	scanner nativeZmodemStartScanner
	lease   uint64
	closed  bool
}

func newTerminalOutputGate(legacy io.Writer) *terminalOutputGate {
	return &terminalOutputGate{legacy: legacy}
}

func (g *terminalOutputGate) Write(p []byte) (int, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.closed {
		return 0, io.ErrClosedPipe
	}
	if g.native != nil {
		return g.native.Write(p)
	}
	if g.armed == nil {
		return g.legacy.Write(p)
	}

	legacy, native, matched := g.scanner.feed(p)
	if matched {
		// Switch ownership before either downstream call. A failed legacy
		// write must not allow later ZMODEM payload into the terminal.
		g.native = g.armed
		g.armed = nil
	}
	if err := writeNativeGateBytes(g.legacy, legacy); err != nil {
		return 0, err
	}
	if matched {
		if err := writeNativeGateBytes(g.native, native); err != nil {
			return 0, err
		}
	}
	// A partial header may be buffered until a later Write or disarm.
	return len(p), nil
}

func writeNativeGateBytes(writer io.Writer, p []byte) error {
	if len(p) == 0 {
		return nil
	}
	n, err := writer.Write(p)
	if err != nil {
		return err
	}
	if n != len(p) {
		return io.ErrShortWrite
	}
	return nil
}

// takeover selects a native consumer immediately. It is serialized behind
// any in-progress legacy Write, and cannot interrupt an armed header probe.
func (g *terminalOutputGate) takeover(native io.Writer) (uint64, error) {
	if native == nil {
		return 0, errors.New("原生协议输出目标为空")
	}
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.closed {
		return 0, io.ErrClosedPipe
	}
	if g.native != nil || g.armed != nil {
		return 0, errTerminalStreamOwned
	}
	g.lease++
	g.native = native
	return g.lease, nil
}

// armOnZmodemHeader pre-installs the native destination without switching
// the live stream yet. The scanner withholds at most 17 possible header bytes.
// On the first complete frame, any preceding text goes to legacy; the entire
// header and all following bytes in that Write go exclusively to native.
//
// IMPORTANT: this is a non-production handoff primitive. The caller must have
// its Rust receiver and stdin routing ready before arming. Never call it from
// inside the downstream legacy Write callback (the gate lock is not reentrant).
func (g *terminalOutputGate) armOnZmodemHeader(native io.Writer) (uint64, error) {
	if native == nil {
		return 0, errors.New("原生协议输出目标为空")
	}
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.closed {
		return 0, io.ErrClosedPipe
	}
	if g.native != nil || g.armed != nil {
		return 0, errTerminalStreamOwned
	}
	g.lease++
	g.scanner = nativeZmodemStartScanner{}
	g.armed = native
	return g.lease, nil
}

// disarm replays the partial, unconfirmed header to the legacy consumer.
// Once a complete header has triggered the native path, only restore is valid.
func (g *terminalOutputGate) disarm(lease uint64) error {
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.closed {
		return io.ErrClosedPipe
	}
	if lease == 0 || lease != g.lease || g.armed == nil || g.native != nil {
		return errTerminalStreamLease
	}
	if err := writeNativeGateBytes(g.legacy, g.scanner.tail); err != nil {
		return err
	}
	g.scanner = nativeZmodemStartScanner{}
	g.armed = nil
	return nil
}

// restore is only safe after the native protocol peers and their readers
// finish. An error never implicitly resumes the legacy terminal stream.
func (g *terminalOutputGate) restore(lease uint64) error {
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.closed {
		return io.ErrClosedPipe
	}
	if g.native == nil || lease == 0 || lease != g.lease {
		return errTerminalStreamLease
	}
	g.native = nil
	g.scanner = nativeZmodemStartScanner{}
	return nil
}

// restoreWithReplay keeps the gate locked while replaying verified post-
// protocol shell output. Without the lock, fresh PTY output could overtake
// bytes withheld after the remote completion marker.
func (g *terminalOutputGate) restoreWithReplay(lease uint64, trailing func() []byte) error {
	if trailing == nil { return errors.New("缺少远端输出恢复数据源") }
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed { return io.ErrClosedPipe }
	if g.native == nil || lease == 0 || g.lease != lease {
		return errTerminalStreamLease
	}
	if err := writeNativeGateBytes(g.legacy, trailing()); err != nil {
		// Preserve native ownership if the original terminal sink failed.
		return err
	}
	g.native = nil
	g.scanner = nativeZmodemStartScanner{}
	return nil
}

func (g *terminalOutputGate) close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed = true
	g.native = nil
	g.armed = nil
	g.scanner = nativeZmodemStartScanner{}
}
