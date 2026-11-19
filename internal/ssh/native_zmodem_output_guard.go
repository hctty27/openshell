package sshclient

import (
	"io"
	"sync"
)

// nativeOnlyOutputGuard keeps unclaimed binary ZMODEM frames away from xterm.
// It is bypassed while a verified native PTY lease is active. Once an
// unsolicited handshake is detected, it quarantines subsequent output and
// leaves the terminal marked unsafe until reconnect instead of guessing at
// protocol boundaries or passing binary data to the user's Shell.
type nativeOnlyOutputGuard struct {
	mu sync.Mutex
	writer io.Writer
	scanner nativeZmodemStartScanner
	quarantined bool
	notify func()
}

func newNativeOnlyOutputGuard(writer io.Writer, notify func()) *nativeOnlyOutputGuard {
	return &nativeOnlyOutputGuard{writer:writer, notify:notify}
}

func (g *nativeOnlyOutputGuard) Write(p []byte) (int,error) {
	g.mu.Lock()
	if g.quarantined {
		g.mu.Unlock()
		return len(p),nil
	}
	plain, _, matched := g.scanner.feed(p)
	if len(plain)>0 {
		n,err:=g.writer.Write(plain)
		if err!=nil || n!=len(plain) {
			g.mu.Unlock()
			if err!=nil{return 0,err}
			return 0,io.ErrShortWrite
		}
	}
	if matched {
		g.quarantined=true
	}
	g.mu.Unlock()
	if matched && g.notify!=nil { g.notify() }
	return len(p),nil
}
