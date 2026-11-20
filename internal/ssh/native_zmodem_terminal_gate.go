package sshclient

import (
	"bytes"
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
	quietPrelude bool
	// Only a nonce-bound remote completion marker may end an armed transfer
	// before the remote side emits its first ZMODEM header.
	preludeMarker []byte
	preludeTail []byte
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
	if !matched && len(g.preludeMarker) > 0 {
		// The remote executable may fail before sending any ZMODEM header
		// (missing file, missing lrzsz, permission denied). Detect only the
		// per-transfer shell exit token, never ordinary prompt text.
		data := make([]byte, 0, len(g.preludeTail)+len(p))
		data = append(data, g.preludeTail...)
		data = append(data, p...)
		if start := bytes.Index(data, g.preludeMarker); start >= 0 {
			g.native = g.armed
			g.armed = nil
			g.preludeMarker = nil
			g.preludeTail = nil
			g.quietPrelude = false
			g.scanner = nativeZmodemStartScanner{}
			if err := writeNativeGateBytes(g.native, data[start:]); err != nil {
				return 0, err
			}
			return len(p), nil
		}
		keep := len(g.preludeMarker) - 1
		if keep > len(data) { keep = len(data) }
		g.preludeTail = append(g.preludeTail[:0], data[len(data)-keep:]...)
	}
	if matched {
		// Switch ownership before either downstream call. A failed legacy
		// write must not allow later ZMODEM payload into the terminal.
		g.native = g.armed
		g.armed = nil
	}
	if !g.quietPrelude {
		if err := writeNativeGateBytes(g.legacy, legacy); err != nil {
			return 0, err
		}
	}
	if matched {
		g.quietPrelude = false
		g.preludeMarker = nil
		g.preludeTail = nil
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

// takeoverCaptured atomically switches a quarantined unsolicited handshake
// to one native consumer and delivers its buffered bytes before admitting
// any later SSH stdout. No file selection, Manager lock or UI callback may
// run inside this gate lock.
func (g *terminalOutputGate) takeoverCaptured(native io.Writer, source *nativeOnlyOutputGuard) (uint64, error) {
	if native == nil || source == nil { return 0, errNativePassiveNoHeader }
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed { return 0, io.ErrClosedPipe }
	if g.native != nil || g.armed != nil { return 0, errTerminalStreamOwned }
	if g.legacy != source { return 0, errNativePassiveNoHeader }
	pending, err := source.claimCaptured()
	if err != nil { return 0, err }
	g.lease++
	g.native = native
	// A writer error cannot release this lease: the unconfirmed terminal
	// remains quarantined and must reconnect.
	if err := writeNativeGateBytes(g.native, pending); err != nil {
		return g.lease, err
	}
	return g.lease, nil
}

// quarantineNative keeps the output lease after a passive Rust sidecar stops.
// The next remote bytes (including an unverified shell prompt) must not reach
// xterm or a closed Rust stdin pipe. Only an explicit, separately verified
// remote-shell boundary can make this lease eligible for restoreWithReplay.
// The output-gate mutex serializes this transition with SSH stdout writes.
func (g *terminalOutputGate) quarantineNative(lease uint64) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed { return io.ErrClosedPipe }
	if g.native == nil || lease == 0 || lease != g.lease {
		return errTerminalStreamLease
	}
	g.native = io.Discard
	return nil
}

// quarantineWithBoundary detaches a completed Rust sidecar while keeping a
// pre-established, nonce-bound shell completion detector on the SSH output
// stream. Only the exact current output lease can make this transition.
// The detector continues consuming output (including split OSC markers),
// while the underlying protocol pipe is never written after sidecar exit.
// This API by itself does not authorize restoring the terminal.
func (g *terminalOutputGate) quarantineWithBoundary(lease uint64, boundary *nativeRemoteBoundarySink) error {
	if boundary == nil { return errors.New("缺少已注册的远端命令完成标记") }
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed { return io.ErrClosedPipe }
	if lease == 0 || g.lease != lease || g.native != boundary {
		return errTerminalStreamLease
	}
	boundary.downstream = io.Discard
	return nil
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
	return g.armOnZmodemHeaderMode(native, false, nil)
}

// armOnZmodemHeaderQuiet prevents the experimental shell command echo from
// entering the visible terminal before ZMODEM owns the output stream.
// No remote tty mode is changed; ordinary sessions keep legacy routing.
func (g *terminalOutputGate) armOnZmodemHeaderQuiet(native io.Writer) (uint64, error) {
	return g.armOnZmodemHeaderMode(native, true, nil)
}

// Before the first protocol header, a missing remote command may terminate
// with a nonce-bound OSC marker. Capture it without exposing shell output
// to the terminal or enabling unverified input.
func (g *terminalOutputGate) armOnZmodemHeaderQuietBoundary(native io.Writer, marker []byte) (uint64, error) {
	if len(marker) == 0 || len(marker) > 256 {
		return 0, errors.New("无效的远端 ZMODEM 完成标记")
	}
	return g.armOnZmodemHeaderMode(native, true, marker)
}

func (g *terminalOutputGate) armOnZmodemHeaderMode(native io.Writer, quiet bool, marker []byte) (uint64, error) {
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
	g.quietPrelude = quiet
	g.preludeMarker = append([]byte(nil), marker...)
	g.preludeTail = nil
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
	g.quietPrelude = false
	g.preludeMarker = nil
	g.preludeTail = nil
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
	g.quietPrelude = false
	g.preludeMarker = nil
	g.preludeTail = nil
	g.scanner = nativeZmodemStartScanner{}
	return nil
}

// restoreVerifiedPassive is exclusively for a remote-shell hook that was
// registered and acknowledged BEFORE the remote program began. The caller
// must validate the nonce-bound completion, finish Rust, and hold this exact
// output lease. Only then is the passive guard reset and post-marker Shell
// output replayed under a single output lock.
func (g *terminalOutputGate) restoreVerifiedPassive(
	lease uint64, boundary *nativeRemoteBoundarySink, guard *nativeOnlyOutputGuard,
) error {
	if boundary == nil || guard == nil {
		return errors.New("缺少可信 Shell 退出证明")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed { return io.ErrClosedPipe }
	if lease == 0 || lease != g.lease || g.native != boundary || g.legacy != guard ||
		!boundary.finished {
		return errTerminalStreamLease
	}
	guard.mu.Lock()
	defer guard.mu.Unlock()
	if !guard.quarantined || !guard.claimed {
		return errNativePassiveNoHeader
	}
	// Replay any bytes arriving after the validated command-complete
	// marker before unlocking the old xterm stream. A replay error leaves
	// both consumers quarantined, never half-restored.
	if err := writeNativeGateBytes(guard.writer, boundary.replayTrailing()); err != nil {
		return err
	}
	guard.quarantined = false
	guard.claimed = false
	guard.capture = false
	guard.captured = nil
	guard.scanner = nativeZmodemStartScanner{quarantineMalformed: true}
	g.native = nil
	g.quietPrelude = false
	g.preludeMarker = nil
	g.preludeTail = nil
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
	g.quietPrelude = false
	g.preludeMarker = nil
	g.preludeTail = nil
	g.scanner = nativeZmodemStartScanner{}
	return nil
}

func (g *terminalOutputGate) close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed = true
	g.native = nil
	g.armed = nil
	g.quietPrelude = false
	g.preludeMarker = nil
	g.preludeTail = nil
	g.scanner = nativeZmodemStartScanner{}
}
