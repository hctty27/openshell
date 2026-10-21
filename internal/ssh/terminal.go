package sshclient

import (
	"encoding/base64"
	"errors"
	"github.com/hctty27/openshell/internal/domain"
	"golang.org/x/crypto/ssh"
	"io"
	"strings"
	"sync"
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

type terminalWriter struct {
	m  *Manager
	c  *connection
	mu sync.Mutex
}

func (w *terminalWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.c.history.Write(p)
	w.c.sequence++
	w.m.emit("ssh:output", map[string]any{"ref": w.c.ref, "sequence": w.c.sequence, "data": base64.StdEncoding.EncodeToString(p)})
	return len(p), nil
}
func (m *Manager) OpenTerminal(ref domain.ConnectionRef, cols, rows int) error {
	if cols < 1 || rows < 1 {
		return errors.New("无效终端尺寸")
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
		return errors.New("终端不存在或已打开")
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
	go func() { s.Wait(); m.emit("ssh:terminal-ended", ref) }()
	return nil
}
func (m *Manager) Write(ref domain.ConnectionRef, data string) error {
	p, e := base64.StdEncoding.DecodeString(data)
	if e != nil || len(p) > 1024*1024 {
		return errors.New("无效终端输入")
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
		return errors.New("无效终端尺寸")
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
