package sshclient

import (
	"regexp"
	"strings"
)

// 仅在确认 Shell 提示符后检测一个全新、未编辑的简单命令。
// 不支持粘贴多行、历史导航、转义、参数或复合 Shell 命令：这些全部走旧路径。
const nativeAutoCommandMaxLength = 256

var nativeAutoDownloadPattern = regexp.MustCompile(`^sz[ \t]+(/[A-Za-z0-9_./-]+)$`)

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

func parseNativeAutoCommand(line string) (direction, remotePath string) {
	if line == "rz" {
		return "upload", ""
	}
	if matches := nativeAutoDownloadPattern.FindStringSubmatch(line); len(matches) == 2 {
		if !strings.Contains(matches[1], "..") {
			return "download", matches[1]
		}
	}
	return "", ""
}

// prepare only replaces Enter with Ctrl-U for a recognized, intentionally
// typed command. All previous keystrokes have already reached the remote
// line editor and must be cleared before the fenced native command is sent.
// The caller must verify sidecar readiness and restore the original bytes
// when native takeover is unavailable.
func (t *nativeAutoInputTracker) prepare(p []byte, shellReady bool) (wire []byte, direction, remotePath string) {
	wire = append([]byte(nil), p...)
	for index, b := range p {
		switch b {
		case '\r', '\n':
			if b == '\r' && index == len(p)-1 && t.started && !t.blocked {
				direction, remotePath = parseNativeAutoCommand(string(t.line))
				if direction != "" {
					wire[index] = 0x15 // Ctrl-U: discard the unsubmitted Bash/readline line
				}
			}
			t.reset()
			shellReady = false
		default:
			if t.blocked {
				continue
			}
			if !t.started {
				if shellReady && (b == 'r' || b == 's') {
					t.started = true
					t.line = append(t.line, b)
				} else {
					t.blocked = true
				}
				continue
			}
			if b < 32 || b > 126 || len(t.line) >= nativeAutoCommandMaxLength {
				t.blocked = true
				t.line = nil
				continue
			}
			t.line = append(t.line, b)
		}
	}
	return wire, direction, remotePath
}

// ConfigureNativeZmodemAuto enables explicit opt-in command interception.
// Passing an empty path disables it, preserving the legacy transfer pipeline.
func (m *Manager) ConfigureNativeZmodemAuto(sidecarPath string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nativeAutoSidecar = sidecarPath
}
