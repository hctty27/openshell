package sshclient

import (
	"encoding/base64"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
	"golang.org/x/crypto/ssh"
	"io"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type History struct {
	mu    sync.Mutex
	b     []byte
	limit int
}

func NewHistory(limit int) *History { return &History{limit: limit} }
func (h *History) Write(p []byte) (int, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := len(p)
	h.b = append(h.b, p...)
	if len(h.b) > h.limit {
		h.b = append([]byte(nil), h.b[len(h.b)-h.limit:]...)
	}
	return n, nil
}
func (h *History) Text(lines, bytes int) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	b := h.b
	for len(b) > 0 && !utf8.RuneStart(b[0]) {
		b = b[1:]
	}
	text := strings.ToValidUTF8(string(b), "�")
	parts := strings.Split(text, "\n")
	if len(parts) > lines {
		text = strings.Join(parts[len(parts)-lines:], "\n")
	}
	if len(text) > bytes {
		text = text[len(text)-bytes:]
		for len(text) > 0 && !utf8.RuneStart(text[0]) {
			text = text[1:]
		}
	}
	return text
}

const terminalOutputChunkSize = 32 * 1024
const terminalOutputFlushDelay = 8 * time.Millisecond

type terminalWriter struct {
	m      *Manager
	c      *connection
	mu     sync.Mutex
	buffer []byte
	timer  *time.Timer
	closed bool
}

func (w *terminalWriter) emitLocked(p []byte) {
	w.c.sequence++
	w.m.emit("ssh:output", map[string]any{
		"ref": w.c.ref, "sequence": w.c.sequence,
		"data": base64.StdEncoding.EncodeToString(p),
	})
}

func (w *terminalWriter) flushLocked() {
	if len(w.buffer) == 0 {
		return
	}
	w.emitLocked(w.buffer)
	w.buffer = w.buffer[:0]
}

func (w *terminalWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return 0, io.ErrClosedPipe
	}
	w.c.history.Write(p)
	w.buffer = append(w.buffer, p...)
	for len(w.buffer) >= terminalOutputChunkSize {
		w.emitLocked(w.buffer[:terminalOutputChunkSize])
		w.buffer = w.buffer[terminalOutputChunkSize:]
	}
	if len(w.buffer) > 0 && w.timer == nil {
		w.timer = time.AfterFunc(terminalOutputFlushDelay, func() {
			w.mu.Lock()
			defer w.mu.Unlock()
			w.timer = nil
			if !w.closed {
				w.flushLocked()
			}
		})
	}
	return len(p), nil
}

func (w *terminalWriter) Close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
	w.flushLocked()
}

func (m *Manager) OpenTerminal(ref domain.ConnectionRef, cols, rows int) error {
	if cols < 1 || rows < 1 {
		return apperror.New("invalidTerminalDimensions", nil)
	}
	s, e := m.OpenSession(ref)
	if e != nil {
		return e
	}
	m.mu.Lock()
	c := m.connections[ref.TabID]
	if c == nil || c.ref != ref || c.terminal != nil {
		m.mu.Unlock()
		s.Close()
		return apperror.New("terminalMissingOrAlreadyOpen", nil)
	}
	c.terminal = s
	m.mu.Unlock()
	fail := func(e error) error { s.Close(); return e }
	stdin, e := s.StdinPipe()
	if e != nil {
		return fail(e)
	}
	m.mu.Lock()
	c.stdin = stdin
	m.mu.Unlock()
	w := &terminalWriter{m: m, c: c}
	s.Stdout = w
	s.Stderr = w
	if e = s.RequestPty("xterm-256color", rows, cols, ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}); e != nil {
		return fail(e)
	}
	if e = s.Shell(); e != nil {
		return fail(e)
	}
	go func() { s.Wait(); w.Close(); m.emit("ssh:terminal-ended", ref) }()
	return nil
}
func (m *Manager) Write(ref domain.ConnectionRef, data string) error {
	p, e := base64.StdEncoding.DecodeString(data)
	if e != nil || len(p) > 1024*1024 {
		return apperror.New("invalidTerminalInput", nil)
	}
	m.mu.Lock()
	c := m.connections[ref.TabID]
	if c == nil || c.ref != ref || c.stdin == nil {
		m.mu.Unlock()
		return io.ErrClosedPipe
	}
	stdin := c.stdin
	m.mu.Unlock()
	_, e = stdin.Write(p)
	return e
}
func (m *Manager) Resize(ref domain.ConnectionRef, cols, rows int) error {
	if cols < 1 || cols > 1000 || rows < 1 || rows > 1000 {
		return apperror.New("invalidTerminalDimensions", nil)
	}
	m.mu.Lock()
	c := m.connections[ref.TabID]
	if c == nil || c.ref != ref || c.terminal == nil {
		m.mu.Unlock()
		return io.ErrClosedPipe
	}
	s := c.terminal
	m.mu.Unlock()
	return s.WindowChange(rows, cols)
}
func (m *Manager) History(ref domain.ConnectionRef) string {
	m.mu.Lock()
	c := m.connections[ref.TabID]
	if c == nil || c.ref != ref {
		m.mu.Unlock()
		return ""
	}
	h := c.history
	m.mu.Unlock()
	return h.Text(200, 32768)
}
