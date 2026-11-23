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
	// While capturing, ordinary output (the echoed probe and bootstrap
	// lines and the prompts in between) is held back instead of shown.
	// It is dropped when the shell answers that it is not Bash or when
	// READY arrives, and shown when installation gives up.
	capturing bool
	captured []byte
}

const (
	nativeHookEventChallenge byte = 1
	nativeHookEventReady byte = 2
	nativeHookEventProbeBash byte = 3
	nativeHookEventProbeOther byte = 4
	nativeHookOSCLimit = 256
	nativeHookCaptureLimit = 256 * 1024
)

// nativeHookCaptureEnd clears the prompt line that was on screen before the
// hidden setup, so the prompt printed after it replaces the old one.
const nativeHookCaptureEnd = "\r\x1b[K"

// beginCapture hides ordinary output until the probe or setup finishes.
func (f *nativePassiveBashHookFilter) beginCapture() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.capturing = true
	f.captured = nil
}

// endCapture stops hiding output. With show, everything held back is
// written to the terminal, so nothing the shell printed is lost when setup
// failed; otherwise it is dropped.
func (f *nativePassiveBashHookFilter) endCapture(show bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.capturing { return nil }
	f.capturing = false
	held := f.captured
	f.captured = nil
	if show && len(held) > 0 { return writeNativeGateBytes(f.dst, held) }
	return nil
}
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
	if bytes.HasPrefix(raw, []byte(nativePassiveBashHookProbePrefix)) && raw[len(raw)-1] == '\x07' {
		if len(raw) > len(nativePassiveBashHookProbePrefix)+1 {
			f.notify(nativeHookEventProbeBash)
		} else {
			f.notify(nativeHookEventProbeOther)
		}
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
	emit := func(b ...byte) {
		if !f.capturing {
			plain = append(plain, b...)
			return
		}
		f.captured = append(f.captured, b...)
		if len(f.captured) > nativeHookCaptureLimit {
			// Never hold back an unbounded amount of output.
			plain = append(plain, f.captured...)
			f.captured = nil
			f.capturing = false
		}
	}
	flush := func() {
		emit(f.pending...)
		f.pending = nil
	}
	for _, ch := range p {
		if len(f.pending)==0 {
			if ch=='\x1b' { f.pending=append(f.pending,ch) } else { emit(ch) }
			continue
		}
		if len(f.pending)==1 && ch!=']' {
			flush()
			if ch=='\x1b' { f.pending=append(f.pending,ch) } else { emit(ch) }
			continue
		}
		f.pending=append(f.pending,ch)
		if ch=='\x07' || (len(f.pending)>2 && f.pending[len(f.pending)-2]=='\x1b' && ch=='\\') {
			raw := f.pending
			if !f.finishOSC(raw) {
				flush()
				continue
			}
			f.pending=nil
			// The probe answer "not Bash" and READY end the hidden setup
			// exactly at this point of the stream: what follows (the new
			// prompt) is shown, what came before is dropped.
			if f.capturing && (bytes.Equal(raw, []byte(nativePassiveBashHookReady)) ||
				bytes.Equal(raw, []byte(nativePassiveBashHookProbePrefix+"\x07"))) {
				f.capturing = false
				f.captured = nil
				plain = append(plain, nativeHookCaptureEnd...)
			}
		} else if len(f.pending)>=nativeHookOSCLimit {
			flush()
		}
	}
	if len(plain)==0 { return len(p),nil }
	if err:=writeNativeGateBytes(f.dst,plain);err!=nil {return 0,err}
	return len(p),nil
}
var _ io.Writer=(*nativePassiveBashHookFilter)(nil)
