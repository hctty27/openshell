package sshclient

import (
	"io"
	"sync"

	"github.com/hctty27/openshell/internal/apperror"
)

// The unclaimed ZMODEM path never writes protocol bytes to xterm. The passive
// experiment retains a bounded prefix until the native sidecar owns the PTY.
const nativePassiveHandshakeBufferLimit = 1 << 20

var (
	errNativePassiveNoHeader = apperror.New("zmodemPassiveNoHandshake", nil)
	errNativePassiveOverflow = apperror.New("zmodemHandshakeOverflow", nil)
)

// nativeOnlyOutputGuard sits behind terminalOutputGate. Normal sessions
// quarantine unsupported ZMODEM; the gated passive experiment additionally
// keeps a bounded copy for one subsequent, atomic Rust-sidecar handoff.
type nativeOnlyOutputGuard struct {
	mu sync.Mutex
	writer io.Writer
	scanner nativeZmodemStartScanner
	quarantined bool
	notify func()
	blockInput func()
	onPassive func(frame byte)
	capture bool
	captured []byte
	claimed bool
}

func newNativeOnlyOutputGuard(writer io.Writer, notify func()) *nativeOnlyOutputGuard {
	return &nativeOnlyOutputGuard{
		writer: writer, notify: notify,
		scanner: nativeZmodemStartScanner{quarantineMalformed: true},
	}
}

// onPassive must schedule any manager/UI work asynchronously. It cannot
// synchronously reenter terminalOutputGate.Write or take the manager lock.
func newNativeOnlyOutputGuardPassive(
	writer io.Writer, notify func(), blockInput func(), onPassive func(byte),
) *nativeOnlyOutputGuard {
	g := newNativeOnlyOutputGuard(writer, notify)
	g.blockInput = blockInput
	g.onPassive = onPassive
	return g
}

func (g *nativeOnlyOutputGuard) Write(p []byte) (int, error) {
	g.mu.Lock()
	if g.quarantined {
		overflow := false
		if g.capture {
			if len(g.captured)+len(p) > nativePassiveHandshakeBufferLimit {
				g.capture = false
				g.captured = nil
				overflow = true
			} else {
				g.captured = append(g.captured, p...)
			}
		}
		g.mu.Unlock()
		if overflow && g.notify != nil { g.notify() }
		return len(p), nil
	}
	plain, protocol, matched := g.scanner.feed(p)
	if len(plain) > 0 {
		n, err := g.writer.Write(plain)
		if err != nil || n != len(plain) {
			g.mu.Unlock()
			if err != nil { return 0, err }
			return 0, io.ErrShortWrite
		}
	}
	var passiveFrame byte
	passive := false
	if matched {
		g.quarantined = true
		// A malformed ZHEX-looking frame may still be damaged protocol data;
		// immediately block user input in either case before any callback.
		if g.blockInput != nil { g.blockInput() }
		if g.onPassive != nil && len(protocol) >= nativeZmodemHeaderSize &&
			nativeZmodemValidStartHeader(protocol[:nativeZmodemHeaderSize]) &&
			len(protocol) <= nativePassiveHandshakeBufferLimit {
			g.capture = true
			g.captured = append(g.captured, protocol...)
			passiveFrame = protocol[5] - '0'
			passive = true
		}
	}
	g.mu.Unlock()
	if passive {
		g.onPassive(passiveFrame)
	} else if matched && g.notify != nil {
		g.notify()
	}
	return len(p), nil
}

// claimCaptured is called *only while the surrounding output gate is
// locked*. It establishes a single consumer for the exact captured bytes;
// future SSH writes then flow to that consumer, preserving wire order.
func (g *nativeOnlyOutputGuard) claimCaptured() ([]byte, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.quarantined || !g.capture || g.claimed ||
		len(g.captured) < nativeZmodemHeaderSize {
		return nil, errNativePassiveNoHeader
	}
	if !nativeZmodemValidStartHeader(g.captured[:nativeZmodemHeaderSize]) {
		return nil, errNativePassiveNoHeader
	}
	data := g.captured
	g.captured = nil
	g.capture = false
	g.claimed = true
	return data, nil
}

// discardCapture releases the bounded handshake buffer when the picker
// expires, is cancelled, or fails authorization. Quarantine itself remains
// active: no bytes can reenter xterm without an SSH reconnect.
func (g *nativeOnlyOutputGuard) discardCapture() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.capture = false
	g.captured = nil
}

func (g *nativeOnlyOutputGuard) pendingCapture() (frame byte, bytes int, ok bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.capture || g.claimed || len(g.captured) < nativeZmodemHeaderSize {
		return 0, 0, false
	}
	return g.captured[5] - '0', len(g.captured), true
}
