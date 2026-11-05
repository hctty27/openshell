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

// terminalOutputGate is the single owner of incoming SSH terminal bytes.
// The legacy trzsz filter remains the default destination. A future native
// transfer may take exclusive ownership at a verified protocol boundary,
// but must never let the same bytes reach both destinations.
type terminalOutputGate struct {
	mu     sync.Mutex
	legacy io.Writer
	native io.Writer
	lease  uint64
	closed bool
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
	return g.legacy.Write(p)
}

// takeover changes the destination only after every earlier Write has
// completed. The returned token prevents an old transfer from restoring
// routing for a newer one. Do not call from inside the downstream writer's
// Write callback, which would be a reentrant acquisition of g.mu.
func (g *terminalOutputGate) takeover(native io.Writer) (uint64, error) {
	if native == nil {
		return 0, errors.New("原生协议输出目标为空")
	}
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.closed {
		return 0, io.ErrClosedPipe
	}
	if g.native != nil {
		return 0, errTerminalStreamOwned
	}
	g.lease++
	g.native = native
	return g.lease, nil
}

// restore is only safe after both native protocol peers and their output
// readers have finished. A native write failure NEVER triggers implicit
// restoration, because subsequent protocol bytes would leak into the
// terminal history and renderer.
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
	return nil
}

func (g *terminalOutputGate) close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed = true
	g.native = nil
}
