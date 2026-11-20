package sshclient

import (
	"strings"
	"unicode/utf8"
)

// A bounded shadow of straightforward shell-line editing is used only at a
// verified POSIX prompt. Unsupported edits are not reinterpreted or executed
// through a fallback transfer engine.
const nativeAutoCommandMaxLength = 4096

type nativeAutoInputTracker struct {
	line    []byte
	started bool
	blocked bool
	authorized bool
}

func (t *nativeAutoInputTracker) reset() {
	t.line = nil
	t.started = false
	t.blocked = false
	t.authorized = false
}

// Interpret only literal shell tokens, not expressions that would change
// meaning when safely quoted for the authenticated remote SSH shell.
func nativeLiteralShellWords(line string) ([]string, bool) {
	if line == "" || !utf8.ValidString(line) { return nil, false }
	var words []string
	var word strings.Builder
	quote := byte(0)
	escaped := false
	seen := false
	for i := 0; i < len(line); i++ {
		ch := line[i]
		if ch < 32 || ch == 127 { return nil, false }
		if escaped {
			word.WriteByte(ch)
			escaped = false
			seen = true
			continue
		}
		switch quote {
		case '\'':
			if ch == '\'' { quote = 0 } else { word.WriteByte(ch) }
		case '"':
			switch ch {
			case '"': quote = 0
			case '\\':
				if i+1 >= len(line) { return nil, false }
				next := line[i+1]
				if next != '"' && next != '\\' { return nil, false }
				escaped = true
			case '$', 96: return nil, false
			default: word.WriteByte(ch)
			}
		default:
			switch ch {
			case ' ':
				if seen { words = append(words, word.String()); word.Reset(); seen = false }
			case '\'', '"':
				quote = ch
				seen = true
			case '\\':
				escaped = true
				seen = true
			case ';', '&', '|', '<', '>', '$', 96, '*', '?', '[', ']', '(', ')', '{', '}', '#', '!', '~':
				return nil, false
			default:
				word.WriteByte(ch)
				seen = true
			}
		}
	}
	if quote != 0 || escaped { return nil, false }
	if seen { words = append(words, word.String()) }
	// The line is already capped at 4096 bytes. Preserve all literal tokens
	// so even an oversized multi-file sz command is explicitly rejected.
	return words, len(words) > 0
}

// Reject recognized transfer commands with shell syntax the native wrapper
// cannot preserve. Never let such a command start an unclaimed ZMODEM stream.
func nativeTransferCommandPrefix(line string) bool {
	line = strings.TrimLeft(line, " \t")
	for _, name := range []string{"rz", "sz", "trz", "tsz"} {
		if !strings.HasPrefix(line, name) { continue }
		if len(line) == len(name) { return true }
		next := line[len(name)]
		if next == ' ' || next == '\t' || next == 96 || next == 39 || next == 34 || next == 92 ||
			strings.ContainsRune(";|&<>(){}$*?!#~", rune(next)) { return true }
	}
	return false
}

func parseNativeAutoCommand(line string) (direction, remotePath string) {
	args, ok := nativeLiteralShellWords(line)
	if !ok {
		if nativeTransferCommandPrefix(line) { return "reject-unsupported", "" }
		return "", ""
	}
	if len(args) == 0 { return "", "" }
	switch args[0] {
	case "rz":
		// Only options whose meaning is preserved by our own remote command
		// generator may be intercepted. Overwrite is an explicit mode and
		// must not be silently downgraded to ordinary upload.
		quiet, overwrite, terminated := false, false, false
		for i, arg := range args[1:] {
			switch arg {
			case "-q":
				if quiet || terminated { return "reject-unsupported", "" }
				quiet = true
			case "-y", "--overwrite":
				if overwrite || terminated { return "reject-unsupported", "" }
				overwrite = true
			case "--":
				if terminated || i != len(args)-2 { return "reject-unsupported", "" }
				terminated = true
			default:
				return "reject-unsupported", ""
			}
		}
		if overwrite { return "upload-overwrite", "" }
		return "upload", ""
	case "trz", "tsz":
		return "reject-unsupported", ""
	case "sz":
		start := 1
		// -q and -- preserve filename semantics. Other switches may change
		// overwrite or conversion behavior and are left to the legacy path.
		if len(args) > start && args[start] == "-q" { start++ }
		if len(args) > start && args[start] == "--" { start++ }
		if len(args)-start < 1 { return "reject-unsupported", "" }
		if len(args)-start > 1 { return "reject-multi", "" }
		for _, file := range args[start:] {
			if file == "" || strings.HasPrefix(file, "-") || strings.ContainsAny(file, "\r\n\x00") {
				return "reject-unsupported", ""
			}
		}
		return "download", args[start]
	}
	// A recognized transfer command never falls back to another engine.
	// Reject non-literal globs/expansions/pipes when the shell is verified.
	return "", ""
}

// A clipboard can submit multiple commands in one terminal Write. If any
// line is rz/sz, forwarding the paste would launch a remote protocol before
// the local sidecar has taken ownership. Discard the complete paste instead.
func nativeTransferMultilinePaste(line []byte, p []byte) bool {
	full := string(line) + string(p)
	parts := strings.FieldsFunc(full, func(r rune) bool { return r == '\r' || r == '\n' })
	if len(parts) < 2 { return false }
	for _, part := range parts {
		if nativeTransferCommandPrefix(part) { return true }
	}
	return false
}

// Previous keystrokes have already reached the remote line editor. Only an
// isolated Enter for a recognized literal command may become Ctrl-U and open
// the native single-file picker. Backspace and line-kill are mirrored in a
// bounded shadow buffer; the remote shell still owns the actual line editor.
func (t *nativeAutoInputTracker) prepare(p []byte, shellReady, shellCandidate bool) (wire []byte, direction, remotePath string) {
	wire = append([]byte(nil), p...)
	if nativeTransferMultilinePaste(t.line, p) {
		t.reset()
		return []byte{0x15}, "reject-multiline", ""
	}
	for index, b := range p {
		switch b {
		case '\r', '\n':
			if t.started && !t.blocked {
				direction, remotePath = parseNativeAutoCommand(string(t.line))
				if direction != "" {
					// Do not allow the rest of this payload to type while
					// the file picker opens. A final CRLF is one newline.
					trailingLF := b == '\r' && index == len(p)-2 && p[index+1] == '\n'
					if index != len(p)-1 && !trailingLF {
						t.reset()
						return append(wire[:index:index], 0x15), "reject-multiline", ""
					}
					authorized := t.authorized
					t.reset()
					wire = append(wire[:index:index], 0x15)
					if !authorized {
						return wire, "reject-unavailable", ""
					}
					return wire, direction, remotePath
				}
			}
			t.reset()
			shellReady = false
		case '\b', 0x7f:
			if t.blocked || !t.started { continue }
			if len(t.line) == 0 { continue }
			_, size := utf8.DecodeLastRune(t.line)
			if size <= 0 { size = 1 }
			t.line = t.line[:len(t.line)-size]
		case 0x15:
			if t.started && !t.blocked {
				t.line = t.line[:0]
			}
		default:
			if t.blocked { continue }
			if !t.started {
				if shellCandidate && (b == 'r' || b == 's' || b == 't') {
					t.started = true
					t.authorized = shellReady
					t.line = append(t.line, b)
				} else { t.blocked = true }
				continue
			}
			if b < 32 || b == 127 || len(t.line) >= nativeAutoCommandMaxLength {
				t.blocked = true
				t.line = nil
				continue
			}
			t.line = append(t.line, b)
		}
	}
	return wire, direction, remotePath
}

func (m *Manager) ConfigureNativeZmodemAuto(sidecarPath string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nativeAutoSidecar = sidecarPath
}
