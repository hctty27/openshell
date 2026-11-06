package sshclient

import (
	"strings"
	"unicode/utf8"
)

// Only unedited commands at verified POSIX shell prompts can be intercepted.
// Expansions, pipelines, history editing and globs remain on the legacy path.
const nativeAutoCommandMaxLength = 4096

type nativeAutoInputTracker struct {
	line    []byte
	started bool
	blocked bool
}

func (t *nativeAutoInputTracker) reset() {
	t.line = nil
	t.started = false
	t.blocked = false
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
	return words, len(words) > 0 && len(words) <= 102
}

func parseNativeAutoCommand(line string) (direction, remotePath string) {
	args, ok := nativeLiteralShellWords(line)
	if !ok || len(args) == 0 { return "", "" }
	switch args[0] {
	case "rz":
		if len(args) == 1 || (len(args) == 2 && (args[1] == "-q" || args[1] == "--")) {
			return "upload", ""
		}
	case "sz":
		start := 1
		// -q and -- preserve filename semantics. Other switches may change
		// overwrite or conversion behavior and are left to the legacy path.
		if len(args) > start && args[start] == "-q" { start++ }
		if len(args) > start && args[start] == "--" { start++ }
		if len(args)-start < 1 || len(args)-start > 100 { return "", "" }
		for _, file := range args[start:] {
			if file == "" || strings.HasPrefix(file, "-") || strings.ContainsAny(file, "\r\n\x00") {
				return "", ""
			}
		}
		return "download", strings.Join(args[start:], "\n")
	}
	return "", ""
}

// Previous keystrokes have already reached the remote line editor. A
// recognized Enter becomes Ctrl-U, followed by a separate GUI authorization.
func (t *nativeAutoInputTracker) prepare(p []byte, shellReady bool) (wire []byte, direction, remotePath string) {
	wire = append([]byte(nil), p...)
	for index, b := range p {
		switch b {
		case '\r', '\n':
			if b == '\r' && index == len(p)-1 && t.started && !t.blocked {
				direction, remotePath = parseNativeAutoCommand(string(t.line))
				if direction != "" { wire[index] = 0x15 }
			}
			t.reset()
			shellReady = false
		default:
			if t.blocked { continue }
			if !t.started {
				if shellReady && (b == 'r' || b == 's') {
					t.started = true
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
