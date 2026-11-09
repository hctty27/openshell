package sshclient

import (
	"encoding/base64"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
	"golang.org/x/crypto/ssh"
	"github.com/trzsz/trzsz-go/trzsz"
	"io"
	"regexp"
	"strconv"
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

// zmodemDirectionWriter observes ZMODEM handshakes and file metadata.
// It forwards the byte stream unchanged to the transfer filter.
type zmodemDirectionWriter struct {
	mu          sync.Mutex
	dst         io.Writer
	tail        []byte
	onDirection func(string) bool
	onTrzsz     func(string, bool) bool
	metadata    *zmodemMetadataParser
}

var zmodemDirectionPattern = regexp.MustCompile(`\*\*\x18B0([01])[0-9a-f]{12}`)
var trzszDirectionPattern = regexp.MustCompile(`::TRZSZ:TRANSFER:([SRDF]):[0-9]+\.[0-9]+\.[0-9]+(?::[0-9]+){0,2}`)

func (w *zmodemDirectionWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	oldLen := len(w.tail)
	data := append(append([]byte(nil), w.tail...), p...)
	var directions []string
	var trzszDirections []struct { direction string; directory bool }
	for _, loc := range trzszDirectionPattern.FindAllSubmatchIndex(data, -1) {
		if loc[1] <= oldLen { continue }
		mode := data[loc[2]]
		direction := "upload"
		if mode == 'S' { direction = "download" }
		trzszDirections = append(trzszDirections, struct { direction string; directory bool }{direction, mode == 'D' || mode == 'F'})
	}
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
	if len(data) > 128 {
		data = data[len(data)-128:]
	}
	w.tail = append(w.tail[:0], data...)
	w.mu.Unlock()

	for _, request := range trzszDirections {
		if w.onTrzsz != nil && !w.onTrzsz(request.direction, request.directory) {
			return len(p), nil
		}
	}
	for _, direction := range directions {
		if w.onDirection != nil {
			if !w.onDirection(direction) {
				return len(p), nil
			}
		}
	}
	if w.metadata != nil {
		w.metadata.Write(p)
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
			current.outputGate = nil
			current.inputGate = nil
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
	inputGate := newTerminalInputGate(filterInput, remoteInput)
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
        if valid {
            connection.transferring = transferring
        }
        event := map[string]any{"ref": ref, "active": transferring}
        if valid && connection.transferID != 0 {
            event["transferId"] = strconv.FormatUint(connection.transferID, 10)
            if !transferring {
                switch {
                case connection.transferFinished:
                    event["status"] = connection.transferStatus
                case connection.transferCancelled:
                    event["status"] = "cancelled"
                case connection.transferProtocol == "zmodem":
                    event["status"] = "failed"
                    event["error"] = "ZMODEM 传输结束，但未收到本地完成确认"
                default:
                    event["status"] = "completed"
                }
            }
        }
        m.mu.Unlock()
        if valid && !transferring {
            _ = filter.SetDefaultDownloadPath("")
        }
        if valid {
            m.emit("ssh:transfer-state", event)
        }
    })
	metadata := newZmodemMetadataParser(
		func(file zmodemFileMetadata) {
			m.mu.Lock()
			valid := m.connections[ref.TabID] == connection && connection.ref == ref &&
				connection.transferID != 0 && connection.transferProtocol == "zmodem" &&
				connection.transferDirection == "download"
			transferID := connection.transferID
			m.mu.Unlock()
			if valid {
				m.emit("ssh:transfer-file", map[string]any{
					"ref": ref, "transferId": strconv.FormatUint(transferID, 10),
					"kind": "start", "name": file.Name, "total": file.Total,
				})
			}
		},
		func(file zmodemFileMetadata, processed uint64) {
			m.mu.Lock()
			valid := m.connections[ref.TabID] == connection && connection.ref == ref &&
				connection.transferID != 0 && connection.transferProtocol == "zmodem" &&
				connection.transferDirection == "download"
			transferID := connection.transferID
			m.mu.Unlock()
			if valid {
				m.emit("ssh:transfer-file", map[string]any{
					"ref": ref, "transferId": strconv.FormatUint(transferID, 10),
					"kind": "completed", "name": file.Name, "total": file.Total,
					"processed": processed,
				})
			}
		},
	)
	observedOutput := &zmodemDirectionWriter{
		dst:      remoteOutput,
		metadata: metadata,
		onDirection: func(direction string) bool {
			return m.selectZmodemPaths(connection, direction, "zmodem", false, filter, remoteInput)
		},
		onTrzsz: func(direction string, directory bool) bool {
			return m.selectZmodemPaths(connection, direction, "trzsz", directory, filter, remoteInput)
		},
	}
	gate := newTerminalOutputGate(observedOutput)
	// The existing trzsz filter remains the sole consumer until an explicit
	// native lease is acquired; raw protocol bytes never bypass this gate.
	session.Stdout, session.Stderr = gate, gate
	if err = session.Shell(); err != nil {
		gate.close()
		inputGate.close()
		filter.Close()
		_ = filterInput.Close()
		_ = remoteOutput.Close()
		_ = filterOutput.Close()
		return rollback(err)
	}
	m.mu.Lock()
	if current := m.connections[ref.TabID]; current != connection || current.ref != ref {
		m.mu.Unlock()
		gate.close()
		inputGate.close()
		filter.Close()
		_ = filterInput.Close()
		_ = remoteOutput.Close()
		_ = session.Close()
		return io.ErrClosedPipe
	}
	connection.stdin = inputGate
	connection.inputGate = inputGate
	connection.filter = filter
	connection.writer = writer
	connection.outputGate = gate
	m.mu.Unlock()
	go func() {
		err := session.Wait()
		_ = err
		m.CancelExperimentalNativeTerminalTransfer(ref)
		gate.close()
		filter.Close()
		_ = filterInput.Close()
		inputGate.close()
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
// Native trzsz emits per-file progress (not an aggregate for multi-file transfers).
var trzszProgressPattern = regexp.MustCompile(`([0-9]{1,3})% \| ([0-9]+(?:\.[0-9]+)? [KMGT]?B)(?: \| ([0-9]+(?:\.[0-9]+)? [KMGT]?B/s))?`)

// trzsz-go emits these messages immediately after the local rz/sz child exits.
// Its transfer-state callback can be delayed until further remote SSH output.
// Accept ANSI SGR variations while keeping the clear-line prefix to avoid
// treating ordinary shell output such as "Success!!" as a transfer result.
var zmodemLocalExitPattern = regexp.MustCompile(`\r\x1b\[2K(?:(?:\x1b\[[0-?]*[ -/]*m)*Success!!(?:\x1b\[[0-?]*[ -/]*m)*|(?:\x1b\[[0-?]*[ -/]*m)*client exit with ([0-9]+)(?:\x1b\[[0-?]*[ -/]*m)*)\r\n`)
func (o *terminalOutputCloser) Write(p []byte) (int, error) {
    o.mu.Lock()
    oldTailSize := len(o.tail)
    data := append(append([]byte(nil), o.tail...), p...)
    matches := zmodemProgressPattern.FindAllSubmatch(data, -1)
    nativeMatches := trzszProgressPattern.FindAllSubmatch(data, -1)
    var exitStatus, exitError string
    locallyExited := false
    for _, loc := range zmodemLocalExitPattern.FindAllStringSubmatchIndex(string(data), -1) {
        if loc[1] <= oldTailSize {
            continue
        }
        locallyExited = true
        if loc[2] >= 0 {
            exitStatus = "failed"
            exitError = "本地 ZMODEM 进程退出，代码 " + string(data[loc[2]:loc[3]])
        } else {
            exitStatus = "completed"
        }
        break
    }
    if len(data) > 256 { data = data[len(data)-256:] }
    o.tail = append(o.tail[:0], data...)
    o.writer.m.mu.Lock()
    transferID := o.writer.c.transferID
    o.writer.m.mu.Unlock()
    transferIDText := ""
    if transferID != 0 {
        transferIDText = strconv.FormatUint(transferID, 10)
    }
    if len(nativeMatches) != 0 && time.Since(o.lastProgress) >= 180*time.Millisecond {
        last := nativeMatches[len(nativeMatches)-1]
        percentage := -1
        if n, err := strconv.Atoi(string(last[1])); err == nil && n <= 100 { percentage = n }
        if percentage >= 0 {
            o.lastProgress = time.Now()
            event := map[string]any{
                "ref": o.writer.c.ref, "protocol": "trzsz", "percent": percentage,
                "transferred": string(last[2]), "speed": string(last[3]),
                "processed": parseZmodemDisplaySize(string(last[2])),
            }
            if transferIDText != "" { event["transferId"] = transferIDText }
            o.writer.m.emit("ssh:transfer-progress", event)
        }
    } else if len(matches) != 0 && time.Since(o.lastProgress) >= 180*time.Millisecond {
        last := matches[len(matches)-1]
        o.lastProgress = time.Now()
        event := map[string]any{
            "ref": o.writer.c.ref,
            "transferred": string(last[1]),
            "speed": string(last[2]),
            "processed": parseZmodemDisplaySize(string(last[1])),
        }
        if transferIDText != "" { event["transferId"] = transferIDText }
        o.writer.m.emit("ssh:transfer-progress", event)
    }
    if locallyExited {
        status := exitStatus
        o.writer.m.mu.Lock()
        if o.writer.c.transferCancelled {
            status = "cancelled"
            exitError = ""
        }
        if current := o.writer.m.connections[o.writer.c.ref.TabID]; current == o.writer.c &&
            o.writer.c.transferID == transferID {
            o.writer.c.transferFinished = true
            o.writer.c.transferStatus = status
        }
        o.writer.m.mu.Unlock()
        event := map[string]any{
            "ref": o.writer.c.ref,
            "status": status,
            "error": exitError,
        }
        if transferIDText != "" { event["transferId"] = transferIDText }
        o.writer.m.emit("ssh:transfer-finished", event)
    }
    o.mu.Unlock()
    return o.writer.Write(p)
}
func parseZmodemDisplaySize(value string) uint64 {
	fields := strings.Fields(strings.TrimSpace(value))
	if len(fields) != 2 {
		return 0
	}
	amount, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || amount < 0 || amount > 1e15 {
		return 0
	}
	multiplier := float64(1)
	switch strings.ToUpper(fields[1]) {
	case "KB":
		multiplier = 1 << 10
	case "MB":
		multiplier = 1 << 20
	case "GB":
		multiplier = 1 << 30
	case "TB":
		multiplier = 1 << 40
	case "PB":
		multiplier = 1 << 50
	case "EB":
		multiplier = 1 << 60
	case "B":
	default:
		return 0
	}
	return uint64(amount * multiplier)
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
	m.mu.Unlock()
	if c == nil { return io.ErrClosedPipe }
	// Serialize manual input with AI takeover. Recheck after taking stdinMu,
	// so pending manual writes cannot cross the ownership transition.
	c.stdinMu.Lock()
	var autoEvent map[string]any
	defer func() {
		c.stdinMu.Unlock()
		if autoEvent != nil {
			m.emit("ssh:native-zmodem-auto-intent", autoEvent)
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
	stdin := c.stdin
	autoSidecar := m.nativeAutoSidecar
	m.mu.Unlock()

	wire := p
	direction, remotePath := "", ""
	if autoSidecar != "" {
		// MySQL may also have a verified prompt; it is not a POSIX Shell.
		ready := c.readiness.readyProgram() == "shell" && c.readiness.checkReady() == nil
		wire, direction, remotePath = c.nativeAutoInput.prepare(p, ready)
		if direction != "" {
			// Never intercept Enter unless a real sidecar and the exact SSH
			// generation are still ready to accept an explicit GUI transfer.
			if status := m.NativeZmodemExperimentalReadiness(ref, autoSidecar, true); !status.Ready {
				wire, direction, remotePath = p, "", ""
			}
		}
	}
	n, err := stdin.Write(wire)
	if err != nil { return err }
	if n != len(wire) { return io.ErrShortWrite }
	// A native lease can reject manual input. Never update shell readiness
	// for bytes that did not actually pass through the legacy input path.
	m.mu.Lock()
	if current := m.connections[ref.TabID]; current == c && c.ref == ref {
		c.readiness.userInput(p)
		if direction != "" {
			autoEvent = map[string]any{"ref": ref, "direction": direction, "remotePath": remotePath, "sessionName": c.session.Name}
		}
	}
	m.mu.Unlock()
	return nil
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
    c.transferCancelled = true
    transferID := c.transferID
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
    if err != nil {
        m.mu.Lock()
        if current := m.connections[ref.TabID]; current == c && c.ref == ref && c.transferID == transferID {
            c.transferCancelled = false
        }
        m.mu.Unlock()
    }
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
