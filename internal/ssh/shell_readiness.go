package sshclient

import (
	"errors"
	"regexp"
	"strings"
	"sync"
	"time"
)

// The explicit shell integration markers (OSC 133/633) are preferred.
// A conservative Bash-style prompt fallback handles basic SSH hosts with no
// shell integration, but never treats arbitrary "#" / "$" as a prompt.
var (
	shellBoundaryPattern = regexp.MustCompile("\x1b\\](?:133|633);([ABCD])(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\\\)")
	alternateBufferPattern = regexp.MustCompile("\x1b\\[\\?(?:47|1047|1049)([hl])")
	shellPromptPattern = regexp.MustCompile("^(?:\\[[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+ [^\\r\\n]{0,120}\\]|[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\\r\\n]{0,120}|[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+ [^\\r\\n]{0,120})[#$%] ?$")
	terminalCSIPattern = regexp.MustCompile("\x1b\\[[0-?]*[ -/]*[@-~]")
	terminalOSCPattern = regexp.MustCompile("\x1b\\][^\x07\x1b]*(?:\x07|\x1b\\\\)")
)

type terminalShellReadiness struct {
	mu sync.Mutex
	tail []byte
	integration bool
	prompt bool
	alternate bool
	manualInput bool
	lastOutput time.Time
}

func (r *terminalShellReadiness) observe(p []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()

	combined := make([]byte, 0, len(r.tail)+len(p))
	combined = append(combined, r.tail...)
	combined = append(combined, p...)

	// Integration events may span SSH data chunks. Process only complete
	// escapes, keeping just enough lookbehind to recognize split sequences.
	for _, match := range shellBoundaryPattern.FindAllSubmatch(combined, -1) {
		r.integration = true
		switch match[1][0] {
		case 'B':
			r.prompt = true
			r.manualInput = false
		case 'A', 'C', 'D':
			r.prompt = false
		}
	}
	for _, match := range alternateBufferPattern.FindAllSubmatch(combined, -1) {
		r.alternate = match[1][0] == 'h'
		if r.alternate { r.prompt = false }
	}

	// For plain shells without integration, infer readiness only from a
	// recognizable full prompt at the end of the current output.
	if !r.integration {
		stripped := terminalOSCPattern.ReplaceAll(combined, nil)
		stripped = terminalCSIPattern.ReplaceAll(stripped, nil)
		visible := strings.TrimRight(string(stripped), "\x00")
		if index := strings.LastIndexAny(visible, "\r\n"); index >= 0 {
			visible = visible[index+1:]
		}
		r.prompt = shellPromptPattern.MatchString(visible)
		if r.prompt { r.manualInput = false }
	}

	r.lastOutput = time.Now()
	if len(combined) > 2048 {
		combined = combined[len(combined)-2048:]
	}
	r.tail = append(r.tail[:0], combined...)
}

func (r *terminalShellReadiness) userInput(p []byte) {
	if len(p) == 0 { return }
	r.mu.Lock()
	r.manualInput = true
	r.prompt = false
	r.mu.Unlock()
}

func (r *terminalShellReadiness) checkReady() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.alternate {
		return errors.New("当前终端正在使用全屏程序，无法交给 AI 操作")
	}
	if r.manualInput {
		return errors.New("终端存在未确认的交互输入，请返回空白 Shell 提示符后重试")
	}
	if !r.prompt {
		return errors.New("无法确认当前 Shell 已就绪。请退出交互程序，返回普通 Bash/Zsh 提示符；支持 OSC 133/633 Shell Integration 的终端可自动识别")
	}
	if !r.integration && time.Since(r.lastOutput) < 250*time.Millisecond {
		return errors.New("终端提示符仍在更新，请稍后重试")
	}
	return nil
}
