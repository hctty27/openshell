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
	mysqlPromptPattern = regexp.MustCompile(`^(?:mysql(?:@[A-Za-z0-9_.:-]+(?:\[[^\r\n\]]{0,120}\])?)?|MariaDB \[[^\r\n\]]{0,120}\])> ?$`)
	mysqlCustomPromptPattern = regexp.MustCompile(`^\(?[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+\)?[^\r\n>]{0,120}> ?package sshclient

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
	mysqlPromptPattern = regexp.MustCompile(`^(?:mysql(?:@[A-Za-z0-9_.:-]+(?:\[[^\r\n\]]{0,120}\])?)?|MariaDB \[[^\r\n\]]{0,120}\])> ?$`)
	)
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
	program string
	mysqlObserved bool
	jumpServer bool
	assetMenu bool
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
	previousBytes := len(r.tail)
	for _, match := range shellBoundaryPattern.FindAllSubmatchIndex(combined, -1) {
		// Avoid replaying a marker fully contained in the lookbehind.
		if match[1] <= previousBytes { continue }
		r.integration = true
		switch combined[match[2]] {
		case 'B':
			r.prompt = true
			r.manualInput = false
		case 'A', 'C', 'D':
			r.prompt = false
		}
	}
	for _, match := range alternateBufferPattern.FindAllSubmatchIndex(combined, -1) {
		if match[1] <= previousBytes { continue }
		r.alternate = combined[match[2]] == 'h'
		if r.alternate { r.prompt = false }
	}

	// For plain shells without integration, infer readiness only from a
	// recognizable full prompt at the end of the current output.
	if strings.Contains(strings.ToLower(string(combined)), "jumpserver") { r.jumpServer = true }
	for _, banner := range []string{"Welcome to the MySQL monitor", "Welcome to the MariaDB monitor"} {
		if index := strings.LastIndex(string(combined), banner); index >= 0 && index+len(banner) > previousBytes {
			r.mysqlObserved = true
		}
	}
	stripped := terminalOSCPattern.ReplaceAll(combined, nil)
	stripped = terminalCSIPattern.ReplaceAll(stripped, nil)
	visible := strings.TrimRight(string(stripped), "\x00")
	if index := strings.LastIndexAny(visible, "\r\n"); index >= 0 {
		visible = visible[index+1:]
	}
	// Returning to KoKo invalidates shell integration markers from the
	// previously selected asset; the next asset may use a different shell.
	if strings.TrimSpace(visible) == "Opt>" {
		r.jumpServer = true
		r.assetMenu = true
		r.integration = false
		r.prompt = false
	}
	// MySQL allows custom prompts (including user@host]database> and user@host|database>).
	// Only consider these prompts after the server's MySQL welcome banner:
	// user-entered input must never be mistaken for a ready SQL client.
	// Database prompts require a different executor from the Shell marker protocol.
	if !r.assetMenu && r.mysqlObserved && (mysqlPromptPattern.MatchString(visible) ||
		mysqlCustomPromptPattern.MatchString(visible)) {
		r.program = "mysql"
		r.prompt = true
		r.manualInput = false
	} else if shellPromptPattern.MatchString(visible) {
		if !r.integration || r.assetMenu || r.program == "mysql" {
			r.program = "shell"
			r.prompt = true
			r.manualInput = false
			r.mysqlObserved = false
		}
		if r.assetMenu { r.assetMenu = false }
	} else if r.program == "mysql" || (!r.integration && !r.assetMenu) {
		r.prompt = false
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

// mysqlReady is used within an acquired PTY lease. It does not impose the
// initial prompt stabilization delay again between sequential AI queries.
func (r *terminalShellReadiness) mysqlReady() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.program == "mysql" && r.prompt && !r.manualInput && !r.alternate && !r.assetMenu
}

func (r *terminalShellReadiness) aiMySQLInputStarted() {
	r.mu.Lock()
	r.manualInput = true
	r.prompt = false
	r.mu.Unlock()
}

// readyProgram must only be read after checkReady succeeds.
func (r *terminalShellReadiness) readyProgram() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.program == "mysql" { return "mysql" }
	return "shell"
}

func (r *terminalShellReadiness) isJumpServer() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.jumpServer
}

func (r *terminalShellReadiness) checkReady() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.assetMenu {
		return errors.New("当前处于 JumpServer 资产菜单（Opt>），请先选择资产并进入 Shell")
	}
	if r.alternate {
		return errors.New("当前终端正在使用全屏程序，无法交给 AI 操作")
	}
	if r.program == "mysql" && (r.manualInput || !r.prompt) {
		return errors.New("MySQL 当前存在未完成的 SQL 或正在执行查询，请等待空白 MySQL 主提示符后重试")
	}
	if r.manualInput {
		return errors.New("终端存在未确认的交互输入，请返回空白 Shell 提示符后重试")
	}
	if !r.prompt {
		return errors.New("无法确认当前 Shell 已就绪。请退出交互程序，返回普通 Bash/Zsh 提示符；支持 OSC 133/633 Shell Integration 的终端可自动识别")
	}
	if (r.program == "mysql" || !r.integration) && time.Since(r.lastOutput) < 250*time.Millisecond {
		return errors.New("终端提示符仍在更新，请稍后重试")
	}
	return nil
}
