package sshclient

import (
	"encoding/base64"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
	"golang.org/x/crypto/ssh"
	"github.com/trzsz/trzsz-go/trzsz"
	"io"
	"regexp"
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
// Bound data already sent to Wails but not yet parsed by xterm.js.
const terminalOutputWindowBytes = 512 * 1024

type outputReceipt struct {
	sequence uint64
	size     int
}

type terminalWriter struct {
	m             *Manager
	c             *connection
	mu            sync.Mutex
	ready         *sync.Cond
	buffer        []byte
	timer         *time.Timer
	closed        bool
	unacknowledged []outputReceipt
	inflightBytes int
}

func (w *terminalWriter) emitLocked(p []byte) {
	if w.ready == nil {
		w.ready = sync.NewCond(&w.mu)
	}
	// Cond.Wait releases w.mu while the UI processes earlier output.
	// Blocking this writer propagates backpressure to the SSH channel.
	for !w.closed && w.inflightBytes+len(p) > terminalOutputWindowBytes {
		w.ready.Wait()
	}
	w.c.sequence++
	w.inflightBytes += len(p)
	w.unacknowledged = append(w.unacknowledged, outputReceipt{sequence: w.c.sequence, size: len(p)})
	w.m.emit("ssh:output", map[string]any{
		"ref": w.c.ref, "sequence": w.c.sequence,
		"data": base64.StdEncoding.EncodeToString(p),
	})
}

// Acknowledge releases all chunks processed through the supplied sequence.
func (w *terminalWriter) Acknowledge(sequence uint64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	index := 0
	for index < len(w.unacknowledged) && w.unacknowledged[index].sequence <= sequence {
		w.inflightBytes -= w.unacknowledged[index].size
		index++
	}
	if index == 0 {
		return
	}
	w.unacknowledged = w.unacknowledged[index:]
	if w.ready != nil {
		w.ready.Broadcast()
	}
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
		// Consume the chunk before emitLocked can wait and release w.mu.
		// Close may otherwise flush or clear w.buffer while this write is paused.
		chunk := append([]byte(nil), w.buffer[:terminalOutputChunkSize]...)
		w.buffer = w.buffer[terminalOutputChunkSize:]
		w.emitLocked(chunk)
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
	if w.ready != nil {
		w.ready.Broadcast()
	}
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
	w.flushLocked()
}

// zmodemDirectionWriter passively observes the remote ZMODEM start header.
// It forwards the byte stream unchanged and does not parse file payloads.
type zmodemDirectionWriter struct {
	mu          sync.Mutex
	dst         io.Writer
	tail        []byte
	onDirection func(string) bool
}

var zmodemDirectionPattern = regexp.MustCompile(`\*\*\x18B0([01])[0-9a-f]{12}`)

func (w *zmodemDirectionWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	oldLen := len(w.tail)
	data := append(append([]byte(nil), w.tail...), p...)
	var directions []string
	for _, loc := range zmodemDirectionPattern.FindAllSubmatchIndex(data, -1) {
		if loc[1] <= oldLen {
			continue
		}
		if data[loc[2]] == '1' {
			directions = append(directions, "upload")
		} else {
			directions = append(directions, "download")
		}
	}
	if len(data) > 32 {
		data = data[len(data)-32:]
	}
	w.tail = append(w.tail[:0], data...)
	w.mu.Unlock()

	for _, direction := range directions {
		if w.onDirection != nil {
			if !w.onDirection(direction) {
				return len(p), nil
			}
		}
	}
	return w.dst.Write(p)
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
			current.writer = nil
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
        if valid && !transferring { _ = filter.SetDefaultDownloadPath("") }
        if valid { m.emit("ssh:transfer-state", map[string]any{"ref": ref, "active": transferring}) }
    })
	observedOutput := &zmodemDirectionWriter{
		dst: remoteOutput,
		onDirection: func(direction string) bool {
            m.emit("ssh:transfer-details", map[string]any{"ref": ref, "direction": direction})
            return m.selectZmodemPaths(connection, direction, filter, remoteInput)
        },
	}
	session.Stdout, session.Stderr = observedOutput, observedOutput
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
	connection.writer = writer
	m.mu.Unlock()
	go func() {
		err := session.Wait()
		_ = err
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
		_ = m.Disconnect(ref)
	}()
	return nil
}

// terminalOutputCloser signals when the filtered output has been fully drained.
type terminalOutputCloser struct {
    writer *terminalWriter
    done chan struct{}
    once sync.Once
    mu sync.Mutex
    tail []byte
    lastProgress time.Time
}
var zmodemProgressPattern = regexp.MustCompile(`Transferred ([0-9.]+[[:space:]]*[KMGTPE]?B), Speed ((?:[0-9.]+[[:space:]]*[KMGTPE]?B/s)|N/A)`)

// trzsz-go emits these messages immediately after the local rz/sz child exits.
// Its transfer-state callback can be delayed until further remote SSH output.
// Observe the exact local protocol message to close the progress UI promptly.
var zmodemLocalExitPattern = regexp.MustCompile(`\r\x1b\[2K(?:\x1b\[1;32mSuccess!!\x1b\[0m|client exit with [0-9]+)\r\n`)
func (o *terminalOutputCloser) Write(p []byte) (int, error) {
    o.mu.Lock()
    oldTailSize := len(o.tail)
    data := append(append([]byte(nil), o.tail...), p...)
    matches := zmodemProgressPattern.FindAllSubmatch(data, -1)
    locallyExited := false
    for _, loc := range zmodemLocalExitPattern.FindAllIndex(data, -1) {
        if loc[1] > oldTailSize {
            locallyExited = true
            break
        }
    }
    if len(data) > 256 { data = data[len(data)-256:] }
    o.tail = append(o.tail[:0], data...)
    if len(matches) != 0 && time.Since(o.lastProgress) >= 180*time.Millisecond {
        last := matches[len(matches)-1]
        o.lastProgress = time.Now()
        o.writer.m.emit("ssh:transfer-progress", map[string]any{
            "ref": o.writer.c.ref,
            "transferred": string(last[1]),
            "speed": string(last[2]),
        })
    }
    if locallyExited {
        o.writer.m.emit("ssh:transfer-finished", map[string]any{
            "ref": o.writer.c.ref,
        })
    }
    o.mu.Unlock()
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
// CancelZmodem requests cancellation through the filter for trzsz, or sends
// an interrupt for legacy ZMODEM, where the filter exposes no stop method.
func (m *Manager) CancelZmodem(ref domain.ConnectionRef) error {
    m.mu.Lock()
    c := m.connections[ref.TabID]
    if c == nil || c.ref != ref || c.stdin == nil {
        m.mu.Unlock()
        return apperror.New("noActiveFileTransfer", nil)
    }
    if c.zmodemSelection != nil {
        releaseZmodemSelection(c)
        m.mu.Unlock()
        return nil
    }
    if !c.transferring {
        m.mu.Unlock()
        return apperror.New("noActiveFileTransfer", nil)
    }
    filter := c.filter
    input := c.stdin
    m.mu.Unlock()
    if filter != nil && filter.IsTransferringFiles() {
        filter.StopTransferringFiles(false)
        return nil
    }
    // ZMODEM has no exported Stop method. Send the terminal interrupt and
    // wait for the pipe write result instead of reporting a false success.
    _, err := input.Write([]byte{0x03})
    return err
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

// AcknowledgeOutput is a no-op for stale or disconnected terminal generations.
func (m *Manager) AcknowledgeOutput(ref domain.ConnectionRef, sequence uint64) {
	m.mu.Lock()
	c := m.connections[ref.TabID]
	var writer *terminalWriter
	if c != nil && c.ref == ref {
		writer = c.writer
	}
	m.mu.Unlock()
	if writer != nil {
		writer.Acknowledge(sequence)
	}
}
