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
	redisPromptPattern = regexp.MustCompile(`^(?:redis> ?|(?:redis\s+)?(?:[A-Za-z0-9_.-]+|\[[0-9A-Fa-f:]+\]):[0-9]{1,5}(?:\[[0-9]+\])?> ?)$`)
	psqlPromptPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,80}=[*!]?[>#] ?package sshclient

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
	redisPromptPattern = regexp.MustCompile(`^(?:redis> ?|(?:redis\s+)?(?:[A-Za-z0-9_.-]+|\[[0-9A-Fa-f:]+\]):[0-9]{1,5}(?:\[[0-9]+\])?> ?)$`)
)
	psqlPasswordPromptPattern = regexp.MustCompile(`(?i)^Password(?: for user [^:\r\n]{1,128})?: ?package sshclient

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
	redisPromptPattern = regexp.MustCompile(`^(?:redis> ?|(?:redis\s+)?(?:[A-Za-z0-9_.-]+|\[[0-9A-Fa-f:]+\]):[0-9]{1,5}(?:\[[0-9]+\])?> ?)$`)
)
	mysqlCustomPromptPattern = regexp.MustCompile(`^\(?[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+\)?[^\r\n>]{0,120}> ?$`)
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
	startedProgram string
	psqlPasswordPrompt bool
	launchInput []byte
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
	// The local editor can submit a shell command through history, a paste or
	// a transformed input path without a complete userInput launch record.
	// Recover only from a freshly echoed *recognized Shell prompt* followed
	// by a direct supported REPL command. Never store the echoed arguments.
	if r.program == "" || r.program == "shell" {
		r.observeREPLLaunchEcho(combined, previousBytes)
	}
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
	// MySQL permits custom user@host]db> and user@host|db> prompt layouts.
	// Require a previously observed MySQL welcome banner before trusting them.
	// Database prompts require a different executor from the Shell marker protocol.
	if !r.assetMenu && (r.program == "psql" || r.startedProgram == "psql") && psqlPasswordPromptPattern.MatchString(visible) {
		// libpq disables terminal echo while waiting for a password. Preserve
		// the detected psql launch, but never buffer authentication input as a
		// new command or retain the password in launchInput.
		r.psqlPasswordPrompt = true
		r.prompt = false
		r.manualInput = false
	} else if !r.assetMenu && r.mysqlObserved && (mysqlPromptPattern.MatchString(visible) ||
		mysqlCustomPromptPattern.MatchString(visible)) {
		r.program = "mysql"
		r.prompt = true
		r.manualInput = false
	} else if r.matchREPLPrompt(visible) {
		r.prompt = true
		r.manualInput = false
		r.startedProgram = ""
		r.psqlPasswordPrompt = false
	} else if shellPromptPattern.MatchString(visible) {
		if !r.integration || r.assetMenu || (r.program != "" && r.program != "shell") {
			r.program = "shell"
			r.prompt = true
			r.manualInput = false
			r.mysqlObserved = false
		}
		r.startedProgram = ""
		r.psqlPasswordPrompt = false
		r.launchInput = nil
		if r.assetMenu { r.assetMenu = false }
	} else if r.program == "mysql" || r.program == "redis" || r.program == "python" ||
		r.program == "psql" || (!r.integration && !r.assetMenu) {
		r.prompt = false
	}

	r.lastOutput = time.Now()
	if len(combined) > 2048 {
		combined = combined[len(combined)-2048:]
	}
	r.tail = append(r.tail[:0], combined...)
}

// REPL identification is tied to a locally observed program launch. Redis and
// Python prompts alone must never grant AI access to arbitrary terminal output.
// Detect the prompt + command line echoed by the remote Shell. A CLI prompt
// alone is not sufficient evidence that the foreground application is Redis.
// A completed line must include newly received PTY bytes so a stale launch
// from the lookbehind cannot be replayed after a program exits.
func (r *terminalShellReadiness) observeREPLLaunchEcho(combined []byte, previousBytes int) {
	start := 0
	for i, b := range combined {
		if b != '\r' && b != '\n' { continue }
		if i + 1 > previousBytes {
			line := string(combined[start:i])
			line = terminalOSCPattern.ReplaceAllString(line, "")
			line = terminalCSIPattern.ReplaceAllString(line, "")
			if launched := replLaunchFromShellEcho(line); launched != "" {
				r.startedProgram = launched
			}
		}
		start = i + 1
	}
}

func replLaunchFromShellEcho(line string) string {
	line = strings.TrimSpace(line)
	for i := 0; i < len(line); i++ {
		if line[i] != '#' && line[i] != '$' && line[i] != '%' { continue }
		if !shellPromptPattern.MatchString(line[:i+1]) { continue }
		// Old trailing prompts may be joined with a freshly echoed command.
		// Keep looking for the last valid prompt, not just the first '#'.
		if launched := replLaunchCommand(strings.TrimSpace(line[i+1:])); launched != "" {
			return launched
		}
	}
	return ""
}

func replLaunchCommand(line string) string {
	fields := strings.Fields(strings.TrimSpace(line))
	if len(fields) == 0 { return "" }
	index := 0
	if fields[0] == "sudo" {
		index++
		if index < len(fields) && fields[index] == "-u" { index += 2 }
	}
	if index >= len(fields) { return "" }
	executable := fields[index]
	if pos := strings.LastIndexByte(executable, '/'); pos >= 0 { executable = executable[pos+1:] }
	switch {
	case executable == "redis-cli":
		return "redis"
	case executable == "psql":
		return "psql"
	case executable == "python" || executable == "python3" ||
		strings.HasPrefix(executable,"python3.") && len(executable) > len("python3."):
		return "python"
	}
	return ""
}

func (r *terminalShellReadiness) matchREPLPrompt(visible string) bool {
	if r.assetMenu || r.alternate { return false }
	switch {
	case redisPromptPattern.MatchString(visible) && (r.program == "redis" || r.startedProgram == "redis"):
		r.program = "redis"
	case visible == ">>> " || visible == ">>>":
		if r.program != "python" && r.startedProgram != "python" { return false }
		r.program = "python"
	case psqlPromptPattern.MatchString(visible) && (r.program == "psql" || r.startedProgram == "psql"):
		r.program = "psql"
	default:
		return false
	}
	return true
}

func (r *terminalShellReadiness) userInput(p []byte) {
	if len(p) == 0 { return }
	r.mu.Lock()
	defer r.mu.Unlock()
	r.manualInput = true
	r.prompt = false
	if r.psqlPasswordPrompt {
		// Password input is intentionally not retained or interpreted as a
		// shell command. The psql prompt will clear this state after auth.
		return
	}
	// Only buffer startup text in a Shell. Interactive Redis/Python sessions
	// may contain passwords; do not accumulate their manual command input.
	if r.program != "" && r.program != "shell" { return }
	for _, b := range p {
		switch b {
		case '\r', '\n':
			r.startedProgram = replLaunchCommand(string(r.launchInput))
			r.launchInput = nil
		case 3:
			r.launchInput = nil
			r.startedProgram = ""
		case 8, 127:
			if len(r.launchInput)>0 { r.launchInput=r.launchInput[:len(r.launchInput)-1] }
		default:
			if b >= 32 && b < 127 && len(r.launchInput) < 256 {
				r.launchInput=append(r.launchInput,b)
			} else if b < 32 || len(r.launchInput) >= 256 {
				r.launchInput = nil
			}
		}
	}
}

// mysqlReady is used within an acquired PTY lease. It does not impose the
// initial prompt stabilization delay again between sequential AI queries.
func (r *terminalShellReadiness) mysqlReady() bool { return r.programReady("mysql") }

func (r *terminalShellReadiness) programReady(program string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.program == program && r.prompt && !r.manualInput && !r.alternate && !r.assetMenu
}

func (r *terminalShellReadiness) aiMySQLInputStarted() {
	r.mu.Lock()
	r.manualInput = true
	r.prompt = false
	r.mu.Unlock()
}

func (r *terminalShellReadiness) aiREPLInputStarted() {
	r.mu.Lock()
	r.manualInput = true
	r.prompt = false
	r.mu.Unlock()
}

// readyProgram must only be read after checkReady succeeds.
func (r *terminalShellReadiness) readyProgram() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.program != "" { return r.program }
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
	if r.psqlPasswordPrompt {
		return errors.New("psql 正在等待数据库密码，请先完成认证后再让 AI 执行")
	}
	if r.alternate {
		return errors.New("当前终端正在使用全屏程序，无法交给 AI 操作")
	}
	if (r.program == "mysql" || r.program == "redis" || r.program == "python" || r.program == "psql") && (r.manualInput || !r.prompt) {
		return errors.New("交互程序当前正在处理输入或命令未结束，请等待空白主提示符后重试")
	}
	if r.manualInput {
		return errors.New("终端存在未确认的交互输入，请返回空白 Shell 提示符后重试")
	}
	if !r.prompt {
		return errors.New("无法确认当前 Shell 已就绪。请退出交互程序，返回普通 Bash/Zsh 提示符；支持 OSC 133/633 Shell Integration 的终端可自动识别")
	}
	if (r.program != "" && r.program != "shell" || !r.integration) && time.Since(r.lastOutput) < 250*time.Millisecond {
		return errors.New("终端提示符仍在更新，请稍后重试")
	}
	return nil
}
