package sshclient

import (
	"encoding/base64"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
	"golang.org/x/crypto/ssh"
	"io"
	"os"
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
	w.c.readiness.observe(p)
	w.m.mu.Lock()
	controller := w.c.aiController
	w.m.mu.Unlock()
	if controller != nil { controller.Observe(p) }
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

// OpenTerminal connects the interactive SSH PTY directly to a native-only
// output gate. No compatibility transfer filter runs in this session.
func (m *Manager) OpenTerminal(ref domain.ConnectionRef, cols, rows int) error {
	if cols < 1 || rows < 1 { return apperror.New("invalidTerminalDimensions", nil) }
	session, err := m.OpenSession(ref)
	if err != nil { return err }
	m.mu.Lock()
	conn := m.connections[ref.TabID]
	if conn == nil || conn.ref != ref || conn.terminal != nil {
		m.mu.Unlock()
		_ = session.Close()
		return apperror.New("terminalMissingOrAlreadyOpen", nil)
	}
	conn.terminal = session
	passiveEnabled := os.Getenv("OPENSHELL_ZMODEM_PASSIVE_EXPERIMENT") == "1" &&
		m.nativeAutoSidecar != ""
	bashRecovery := passiveEnabled && os.Getenv("OPENSHELL_ZMODEM_PASSIVE_BASH_RECOVERY") == "1"
	m.mu.Unlock()
	rollback := func(cause error) error {
		_ = session.Close()
		m.mu.Lock()
		if current := m.connections[ref.TabID]; current == conn {
			current.terminal = nil
			current.stdin = nil
			current.writer = nil
			current.inputGate = nil
			current.outputGate = nil
			current.outputGuard = nil
		}
		m.mu.Unlock()
		return cause
	}
	remoteInput, err := session.StdinPipe()
	if err != nil { return rollback(err) }
	if err = session.RequestPty("xterm-256color", rows, cols,
		ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}); err != nil {
		return rollback(err)
	}
	inputGate := newTerminalInputGate(remoteInput, remoteInput)
	writer := &terminalWriter{m: m, c: conn}
	onUnsupported := func() {
		// Called outside the scanner mutex. Revoke any pending passive
		// selection immediately on a malformed frame or prebuffer overflow.
		// The generation check suppresses stale SSH notifications.
		m.failNativePassiveGuard(ref, conn)
	}
	var legacy io.Writer = writer
	var bashFilter *nativePassiveBashHookFilter
	if bashRecovery {
		bashFilter = newNativePassiveBashHookFilter(writer)
		legacy = bashFilter
	}
	guard := newNativeOnlyOutputGuard(legacy, onUnsupported)
	if passiveEnabled {
		guard = newNativeOnlyOutputGuardPassive(legacy, onUnsupported,
			inputGate.blockPassiveInput, func(frame byte) {
				// Never reenter manager or output-gate locks from their own Write.
				go m.handleNativePassiveFrame(ref, conn, frame)
			})
	}
	gate := newTerminalOutputGate(guard)
	session.Stdout, session.Stderr = gate, gate
	if err = session.Shell(); err != nil {
		gate.close()
		inputGate.close()
		writer.Close()
		return rollback(err)
	}
	m.mu.Lock()
	if current := m.connections[ref.TabID]; current != conn || current.ref != ref {
		m.mu.Unlock()
		gate.close()
		inputGate.close()
		writer.Close()
		_ = session.Close()
		return io.ErrClosedPipe
	}
	conn.stdin = inputGate
	conn.inputGate = inputGate
	conn.outputGate = gate
	conn.outputGuard = guard
	conn.writer = writer
	if bashFilter != nil {
		conn.passiveBashHookFilter = bashFilter
		conn.passiveBashHookInstalling = true
	}
	m.mu.Unlock()
	if bashFilter != nil {
		go m.installNativePassiveBashHook(ref, conn)
	}
	go func() {
		_ = session.Wait()
		m.CancelExperimentalNativeTerminalTransfer(ref)
		gate.close()
		inputGate.close()
		writer.Close()
		m.emit("ssh:terminal-ended", ref)
		_ = m.Disconnect(ref)
	}()
	return nil
}

func (m *Manager) Write(ref domain.ConnectionRef, data string) error {
	p, e := base64.StdEncoding.DecodeString(data)
	if e != nil || len(p) > 1024*1024 {
		return apperror.New("invalidTerminalInput", nil)
	}
	m.mu.Lock()
	c := m.connections[ref.TabID]
	m.mu.Unlock()
	if c == nil { return io.ErrClosedPipe }
	// Serialize manual input with AI takeover. Recheck after taking stdinMu,
	// so pending manual writes cannot cross the ownership transition.
	c.stdinMu.Lock()
	var autoEvent map[string]any
	var autoError string
	defer func() {
		c.stdinMu.Unlock()
		if autoEvent != nil {
			m.emit("ssh:native-zmodem-auto-intent", autoEvent)
		}
		if autoError != "" {
			m.emit("ssh:native-zmodem-command-error", map[string]any{"ref": ref, "error": autoError})
		}
	}()
	m.mu.Lock()
	if current := m.connections[ref.TabID]; current != c || c.ref != ref || c.stdin == nil {
		m.mu.Unlock()
		return io.ErrClosedPipe
	}
	if c.aiController != nil {
		m.mu.Unlock()
		return errAITerminalBusy
	}
	if c.nativeTerminalTransfer != nil || c.nativeTerminalPoisoned || c.nativeZmodemSelection ||
		c.passiveBashHookInstalling {
		m.mu.Unlock()
		return errNativeTerminalInputBusy
	}
	stdin := c.stdin
	autoSidecar := m.nativeAutoSidecar
	m.mu.Unlock()

	// Even without a usable native sidecar, never forward a recognized
	// rz/sz command into an unsupported fallback protocol handler.
	candidate, ready := c.readiness.nativeZmodemInputState()
	wire, direction, remotePath := c.nativeAutoInput.prepare(p, ready, candidate)
	if direction == "upload" || direction == "upload-overwrite" || direction == "download" {
		if status := m.NativeZmodemExperimentalReadiness(ref, autoSidecar, true); !status.Ready {
			autoError = status.Message
			direction = "reject-unavailable"
		}
	}
	// Mark the terminal busy before writing. The remote process can return a
	// prompt before stdin.Write completes; recording input afterward can
	// overwrite that prompt and leave the REPL permanently marked busy.
	c.readiness.userInput(p)

	n, err := stdin.Write(wire)
	if err != nil { return err }
	if n != len(wire) { return io.ErrShortWrite }

	if direction == "reject-multi" {
		autoError = "ZMODEM 每次只能传输一个文件；批量传输请使用 SFTP"
	} else if direction == "reject-multiline" {
		autoError = "已拦截包含 rz/sz 的多行粘贴，防止在原生传输接管前启动远端协议；请单独输入 rz/sz 命令"
	} else if direction == "reject-unsupported" {
		autoError = "仅支持原生单文件 rz、rz -y、rz --overwrite、rz -q 及 sz 文件名；其他不支持的参数或复杂 Shell 语法请使用 SFTP"
	} else if direction == "reject-unavailable" {
		// A missing/unstable prompt (or a missing sidecar) is never permission
		// to start the remote rz/sz program. Ctrl-U already erased its line.
		if autoError == "" {
			autoError = "当前无法确认安全的 Shell 提示符；已阻止 rz/sz 在服务器启动，请等待提示符稳定后重新输入命令"
		}
	} else if direction != "" {
		m.mu.Lock()
		if current := m.connections[ref.TabID]; current == c && c.ref == ref &&
			c.nativeTerminalTransfer == nil && !c.nativeTerminalPoisoned {
			// Reserve the PTY synchronously with this recognized intent.
			// Picker cancellation or transfer admission releases this reservation.
			c.nativeZmodemSelection = true
			c.nativeZmodemSelectionID++
			autoEvent = map[string]any{"ref": ref, "direction": direction, "remotePath": remotePath,
				"sessionName": c.session.Name, "selectionId": c.nativeZmodemSelectionID}
		}
		m.mu.Unlock()
	}
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
