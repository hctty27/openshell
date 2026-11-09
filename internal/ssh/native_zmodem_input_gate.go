package sshclient

import (
	"errors"
	"io"
	"sync"
)

var (
	errNativeTerminalInputBusy = errors.New("native terminal input busy")
	errNativeTerminalInputLease = errors.New("终端输入独占令牌已失效")
)

// terminalInputGate keeps interactive input separate from the native protocol.
// Normal writes go through trzsz-go. Once leased, only the holder of the
// current token can write raw protocol responses directly to the SSH PTY.
type terminalInputGate struct {
	mu sync.Mutex
	legacy io.Writer
	remote io.Writer
	leased bool
	lease uint64
	closed bool
}

func newTerminalInputGate(legacy, remote io.Writer) *terminalInputGate {
	return &terminalInputGate{legacy: legacy, remote: remote}
}

// Write is the user/AI entrypoint, never a native protocol entrypoint.
func (g *terminalInputGate) Write(p []byte) (int, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return 0, io.ErrClosedPipe
	}
	if g.leased {
		return 0, errNativeTerminalInputBusy
	}
	return g.legacy.Write(p)
}

// takeover waits for the current legacy Write to finish before blocking
// subsequent manual/AI input. The independent output gate owns SSH output.
func (g *terminalInputGate) takeover() (uint64, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return 0, io.ErrClosedPipe
	}
	if g.leased {
		return 0, errNativeTerminalInputBusy
	}
	g.lease++
	g.leased = true
	return g.lease, nil
}

func (g *terminalInputGate) writeNative(lease uint64, p []byte) (int, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return 0, io.ErrClosedPipe
	}
	if !g.leased || lease == 0 || lease != g.lease {
		return 0, errNativeTerminalInputLease
	}
	return g.remote.Write(p)
}

// restore is explicit: the transfer coordinator must have finished draining
// both sides. A native write error must not implicitly unblock user input.
func (g *terminalInputGate) restore(lease uint64) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return io.ErrClosedPipe
	}
	if !g.leased || lease == 0 || lease != g.lease {
		return errNativeTerminalInputLease
	}
	g.leased = false
	return nil
}

func (g *terminalInputGate) close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed = true
}
