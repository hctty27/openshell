package sshclient

import (
	"bytes"
	"io"
	"strconv"
	"sync"
)

// nativePassiveBashHookFilter is a bounded OSC stream filter. It strips only
// OpenShell's private hook challenge/ack/exit markers from the visible xterm
// stream, leaving all other OSC/CSI and ordinary output byte-exact.
// Stage notifications only use a buffered channel: callbacks from this
// SSH output path MUST NOT acquire Manager or input-gate locks.
type nativePassiveBashHookFilter struct {
	mu sync.Mutex
	dst io.Writer
	pending []byte
	token string
	events chan byte
}

const (
	nativeHookEventChallenge byte = 1
	nativeHookEventReady byte = 2
	nativeHookOSCLimit = 256
)
func newNativePassiveBashHookFilter(dst io.Writer) *nativePassiveBashHookFilter {
	return &nativePassiveBashHookFilter{dst:dst, events:make(chan byte, 8)}
}

func (f *nativePassiveBashHookFilter) setToken(token string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.token = token
}
func (f *nativePassiveBashHookFilter) notify(event byte) {
	select { case f.events <- event: default: }
}
func (f *nativePassiveBashHookFilter) finishOSC(raw []byte) bool {
	switch string(raw) {
	case nativePassiveBashHookChallenge:
		f.notify(nativeHookEventChallenge)
		return true
	case nativePassiveBashHookReady:
		f.notify(nativeHookEventReady)
		return true
	}
	if f.token == "" || !bytes.HasPrefix(raw, []byte("\x1b]777;OpenShellNativeZmodem;"+f.token+";")) ||
		len(raw) < 2 || raw[len(raw)-1] != '\x07' {
		return false
	}
	prefix := len("\x1b]777;OpenShellNativeZmodem;"+f.token+";")
	if prefix >= len(raw)-1 || len(raw)-prefix > 4 { return false }
	_, err := strconv.Atoi(string(raw[prefix:len(raw)-1]))
	return err == nil
}

func (f *nativePassiveBashHookFilter) Write(p []byte) (int,error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var plain []byte
	flush := func() {
		plain = append(plain,f.pending...)
		f.pending = nil
	}
	for _, ch := range p {
		if len(f.pending)==0 {
			if ch=='\x1b' { f.pending=append(f.pending,ch) } else { plain=append(plain,ch) }
			continue
		}
		if len(f.pending)==1 && ch!=']' {
			flush()
			if ch=='\x1b' { f.pending=append(f.pending,ch) } else { plain=append(plain,ch) }
			continue
		}
		f.pending=append(f.pending,ch)
		if ch=='\x07' || (len(f.pending)>2 && f.pending[len(f.pending)-2]=='\x1b' && ch=='\\') {
			if !f.finishOSC(f.pending) { flush() } else { f.pending=nil }
		} else if len(f.pending)>=nativeHookOSCLimit {
			flush()
		}
	}
	if len(plain)==0 { return len(p),nil }
	if err:=writeNativeGateBytes(f.dst,plain);err!=nil {return 0,err}
	return len(p),nil
}
var _ io.Writer=(*nativePassiveBashHookFilter)(nil)
