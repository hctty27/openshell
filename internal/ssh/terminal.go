package sshclient

import (
	"encoding/base64"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
	"golang.org/x/crypto/ssh"
	"github.com/trzsz/trzsz-go/trzsz"
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

// OpenTerminal connects the existing SSH PTY to an isolated binary-safe transfer
// filter. Only filtered, printable output reaches history and the renderer.
func (m *Manager) OpenTerminal(ref domain.ConnectionRef, cols, rows int) error {
	if cols < 1 || rows < 1 {
		return apperror.New("invalidTerminalDimensions", nil)
	}
	session, err := m.OpenSession(ref)
	if err != nil { return err }
	m.mu.Lock()
	connection := m.connections[ref.TabID]
	if connection == nil || connection.ref != ref || connection.terminal != nil {
		m.mu.Unlock()
		_ = session.Close()
		return apperror.New("terminalMissingOrAlreadyOpen", nil)
	}
	connection.terminal = session
	m.mu.Unlock()
	rollback := func(err error) error {
		_ = session.Close()
		m.mu.Lock()
		if current := m.connections[ref.TabID]; current == connection {
			current.terminal = nil
			current.stdin = nil
			current.filter = nil
		}
		m.mu.Unlock()
		return err
	}
	remoteInput, err := session.StdinPipe()
	if err != nil { return rollback(err) }
	if err = session.RequestPty("xterm-256color", rows, cols,
		ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}); err != nil {
		return rollback(err)
	}

	userInput, filterInput := io.Pipe()
	filterOutput, remoteOutput := io.Pipe()
	outputDone := make(chan struct{})
	writer := &terminalWriter{m: m, c: connection}
	clientOutput := &terminalOutputCloser{writer: writer, done: outputDone}
	filter := trzsz.NewTrzszFilter(userInput, clientOutput, remoteInput, filterOutput,
		trzsz.TrzszOptions{TerminalColumns: int32(cols), EnableZmodem: true})
	filter.SetTransferStateCallback(func(transferring bool) {
        m.mu.Lock()
        current := m.connections[ref.TabID]
        valid := current == connection && current.ref == ref
        if valid { connection.transferring = transferring }
        m.mu.Unlock()
        if valid { m.emit("ssh:transfer-state", map[string]any{"ref": ref, "active": transferring}) }
    })
	session.Stdout, session.Stderr = remoteOutput, remoteOutput
	if err = session.Shell(); err != nil {
		filter.Close()
		_ = filterInput.Close()
		_ = remoteOutput.Close()
		_ = filterOutput.Close()
		return rollback(err)
	}
	m.mu.Lock()
	if current := m.connections[ref.TabID]; current != connection || current.ref != ref {
		m.mu.Unlock()
		filter.Close()
		_ = filterInput.Close()
		_ = remoteOutput.Close()
		_ = session.Close()
		return io.ErrClosedPipe
	}
	connection.stdin = filterInput
	connection.filter = filter
	m.mu.Unlock()
	go func() {
		_ = session.Wait()
		filter.Close()
		_ = filterInput.Close()
		_ = remoteOutput.Close()
		select {
		case <-outputDone:
		case <-time.After(2 * time.Second):
			clientOutput.Close()
		}
		m.emit("ssh:transfer-state", map[string]any{"ref": ref, "active": false})
		m.emit("ssh:terminal-ended", ref)
	}()
	return nil
}

// terminalOutputCloser signals when the filtered output has been fully drained.
type terminalOutputCloser struct {
	writer *terminalWriter
	done chan struct{}
	once sync.Once
}
func (o *terminalOutputCloser) Write(p []byte) (int, error) {
	return o.writer.Write(p)
}
func (o *terminalOutputCloser) Close() error {
	o.once.Do(func() { o.writer.Close(); close(o.done) })
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
// CancelZmodem sends the filter's supported Ctrl+C cancellation sequence.
func (m *Manager) CancelZmodem(ref domain.ConnectionRef) error {
    m.mu.Lock()
    c := m.connections[ref.TabID]
    if c == nil || c.ref != ref || c.stdin == nil || !c.transferring {
        m.mu.Unlock()
        return apperror.New("noActiveFileTransfer", nil)
    }
    stdin := c.stdin
    m.mu.Unlock()
    // A pipe may momentarily block while the filter handles incoming data.
    // The reader is closed with the SSH session, so a failed transfer cannot
    // permanently block this UI call.
    go func() { _, _ = stdin.Write([]byte{0x03}) }()
    return nil
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
	if err := s.WindowChange(rows, cols); err != nil { return err }
	m.mu.Lock()
	if current := m.connections[ref.TabID]; current != nil && current.ref == ref && current.filter != nil { current.filter.SetTerminalColumns(int32(cols)) }
	m.mu.Unlock()
	return nil
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
