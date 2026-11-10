package sshclient

import (
    "bytes"
    "context"
    "errors"
    "fmt"
    "regexp"
    "strconv"
    "strings"
    "sync"
    "time"

    "github.com/hctty27/openshell/internal/domain"
)

const terminalAIOutputLimit = 64 * 1024

var (
    errAITerminalBusy = errors.New("此终端已由 AI 接管")
    errAITerminalUnavailable = errors.New("当前终端未就绪或正在传输文件")
    terminalAIColor = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
    terminalAIOsc = regexp.MustCompile(`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`)
)

// AITerminalLease owns the existing PTY while the agent is running. All
// commands use this same shell, preserving its current directory and exports.
type AITerminalLease struct {
    manager *Manager
    connection *connection
    ref domain.ConnectionRef
    mu sync.Mutex
    current *terminalAICommand
    closed chan struct{}
    once sync.Once
    ready bool
    program string
    poisoned bool
}

type terminalAICommand struct {
    marker []byte
    mysql *mysqlAIState
    repl *replAIState
    pending []byte
    output []byte
    truncated bool
    done chan terminalAIResult
    finished bool
}

type terminalAIResult struct {
    output string
    code int
}

func (m *Manager) AcquireAITerminal(ref domain.ConnectionRef) (*AITerminalLease, error) {
    m.mu.Lock()
    conn := m.connections[ref.TabID]
    m.mu.Unlock()
    if conn == nil { return nil,errAITerminalUnavailable }
    conn.stdinMu.Lock()
    defer conn.stdinMu.Unlock()
    m.mu.Lock()
    defer m.mu.Unlock()
    if m.connections[ref.TabID] != conn || conn.ref != ref ||
        conn.terminal == nil || conn.stdin == nil || conn.filter == nil ||
        conn.transferring || conn.zmodemSelection != nil || conn.nativeTerminalTransfer != nil || conn.nativeTerminalPoisoned {
        return nil, errAITerminalUnavailable
    }
    if conn.aiController != nil { return nil, errAITerminalBusy }
    if err := conn.readiness.checkReady(); err != nil { return nil, err }
    lease := &AITerminalLease{manager:m,connection:conn,ref:ref,closed:make(chan struct{}),program:conn.readiness.readyProgram()}
    conn.aiController = lease
    return lease,nil
}

func (lease *AITerminalLease) Release() {
    lease.once.Do(func() {
        close(lease.closed)
        lease.connection.stdinMu.Lock()
        defer lease.connection.stdinMu.Unlock()
        m := lease.manager
        m.mu.Lock()
        if c := m.connections[lease.ref.TabID]; c == lease.connection && c.aiController == lease {
            c.aiController = nil
        }
        m.mu.Unlock()
    })
}

func (lease *AITerminalLease) Ref() domain.ConnectionRef { return lease.ref }

func (lease *AITerminalLease) Failed() bool {
    lease.mu.Lock()
    defer lease.mu.Unlock()
    return lease.poisoned
}

func (lease *AITerminalLease) markFailed() {
    lease.mu.Lock()
    lease.poisoned = true
    lease.mu.Unlock()
}

func (lease *AITerminalLease) validInput() (interface{ Write([]byte)(int,error) }, error) {
    lease.manager.mu.Lock()
    defer lease.manager.mu.Unlock()
    c := lease.manager.connections[lease.ref.TabID]
    if c == nil || c != lease.connection || c.ref != lease.ref ||
        c.aiController != lease || c.stdin == nil || c.transferring || c.zmodemSelection != nil || c.nativeTerminalTransfer != nil || c.nativeTerminalPoisoned {
        return nil,errAITerminalUnavailable
    }
    return c.stdin,nil
}

func (lease *AITerminalLease) send(data []byte) error {
    lease.connection.stdinMu.Lock()
    defer lease.connection.stdinMu.Unlock()
    input, err := lease.validInput()
    if err != nil { return err }
    _,err = input.Write(data)
    return err
}

func (lease *AITerminalLease) interrupt() {
    lease.connection.stdinMu.Lock()
    defer lease.connection.stdinMu.Unlock()
    input, err := lease.validInput()
    if err == nil { _,_ = input.Write([]byte{3}) }
}

func (lease *AITerminalLease) runMarker(ctx context.Context, command string, isProbe bool) (terminalAIResult,error) {
    lease.mu.Lock()
    if lease.poisoned {
        lease.mu.Unlock()
        return terminalAIResult{}, errors.New("终端命令状态不可确认，已暂停自动执行")
    }
    if lease.current != nil {
        lease.mu.Unlock()
        return terminalAIResult{}, errors.New("此终端已有一条 AI 命令正在执行")
    }
    nonce := strings.ReplaceAll(domain.NewID(), "-", "")
    marker := []byte("\x1b]777;OpenShellAI;" + nonce + ";")
    running := &terminalAICommand{marker:marker,done:make(chan terminalAIResult,1)}
    lease.current = running
    lease.mu.Unlock()

    defer func() {
        lease.mu.Lock()
        if lease.current == running { lease.current = nil }
        lease.mu.Unlock()
    }()

    // One syntactically complete shell command; the marker cannot become
    // stdin to a long-running child process. The brace group preserves cwd.
    // An interactive editor, incomplete shell input or unsupported shell
    // cannot produce the marker and will fail closed.
    var source string
    if isProbe {
        source = "printf '\\033]777;OpenShellAI;" + nonce + ";0\\007'\r"
    } else {
        source = "{\n" + command + "\n}; __openshell_ai_rc=$?; printf '\\033]777;OpenShellAI;" + nonce + ";%s\\007' \"$__openshell_ai_rc\"\r"
    }
    if err := lease.send([]byte(source)); err != nil {
        lease.markFailed()
        return terminalAIResult{},err
    }

    select {
    case result := <-running.done:
        return result,nil
    case <-ctx.Done():
        lease.markFailed()
        lease.interrupt()
        return terminalAIResult{},ctx.Err()
    case <-lease.closed:
        lease.markFailed()
        return terminalAIResult{}, errors.New("SSH 终端已经释放或断开")
    }
}

// Run performs one command in the visible terminal. A short probe verifies
// that the terminal is actually at a shell prompt before any AI command.
func (lease *AITerminalLease) Run(ctx context.Context, command string) (string, error) {
	if strings.TrimSpace(command) == "" || len(command) > 8192 ||
		strings.ContainsRune(command, 0) {
		return "", errors.New("终端命令长度或内容无效")
	}
	if lease.program == "mysql" {
		return lease.runMySQL(ctx, command)
	}
	if lease.program == "redis" || lease.program == "python" || lease.program == "psql" {
		return lease.runREPL(ctx, command)
	}
	if !lease.ready {
		probeCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
		_, err := lease.runMarker(probeCtx, "", true)
		if err == nil {
			err = lease.waitForShellPrompt(probeCtx)
		}
		cancel()
		if err != nil {
			lease.markFailed()
			return "", fmt.Errorf("终端未返回就绪标记或 Shell 提示符未恢复，请确认处于空白的 Shell 提示符（非 vim/top/传输）：%w", err)
		}
		lease.ready = true
	}
	result, err := lease.runMarker(ctx, command, false)
	if err != nil {
		return "", err
	}
	if result.code < 0 {
		lease.markFailed()
		return "", errors.New("终端命令结束标记格式无效，已停止继续执行")
	}
	promptCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	err = lease.waitForShellPrompt(promptCtx)
	cancel()
	if err != nil {
		lease.markFailed()
		return "", fmt.Errorf("Shell 命令已结束，但未确认提示符恢复: %w", err)
	}
	return fmt.Sprintf("%s\n退出状态: %d", result.output, result.code), nil
}

func (lease *AITerminalLease) waitForShellPrompt(ctx context.Context) error {
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if lease.connection.readiness.readyProgram() != "shell" {
			return errors.New("Shell 已退出或提示符发生变化，无法确认命令结束")
		}
		if err := lease.connection.readiness.checkReady(); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("等待 Shell 提示符恢复超时: %w", ctx.Err())
		case <-lease.closed:
			return errors.New("SSH 终端已经释放或断开")
		case <-ticker.C:
		}
	}
}

func (lease *AITerminalLease) Observe(p []byte) {
    lease.mu.Lock()
    defer lease.mu.Unlock()
    current := lease.current
    if current == nil || current.finished {return}
    if current.mysql != nil {
        current.consumeMySQL(p)
        return
    }
    if current.repl != nil {
        current.consumeREPL(p)
        return
    }
    current.consume(p)
}

func (cmd *terminalAICommand) appendOutput(p []byte) {
    if len(p)==0 { return }
    free := terminalAIOutputLimit-len(cmd.output)
    if free<=0 {cmd.truncated=true;return}
    if len(p)>free {p=p[:free];cmd.truncated=true}
    cmd.output=append(cmd.output,p...)
}

func (cmd *terminalAICommand) consume(p []byte) {
    // Keep a bounded lookbehind so OSC markers spanning SSH output chunks
    // are detected without storing the entire terminal stream.
    data:=append(cmd.pending,p...)
    start:=bytes.Index(data,cmd.marker)
    if start<0 {
        keep:=len(cmd.marker)-1
        if len(data)>keep {
            cmd.appendOutput(data[:len(data)-keep])
            cmd.pending=append(cmd.pending[:0],data[len(data)-keep:]...)
        } else {
            cmd.pending=append(cmd.pending[:0],data...)
        }
        return
    }
    suffix:=data[start+len(cmd.marker):]
    end:=bytes.IndexByte(suffix,7)
    if end<0 {
        cmd.appendOutput(data[:start])
        cmd.pending=append(cmd.pending[:0],data[start:]...)
        if len(cmd.pending)>256 {
            cmd.pending=cmd.pending[:0]
            cmd.finished=true
            cmd.done<-terminalAIResult{output:"终端返回的结束标记格式无效",code:-1}
        }
        return
    }
    cmd.appendOutput(data[:start])
    code,err:=strconv.Atoi(string(suffix[:end]))
    if err!=nil {code=-1}
    result:=terminalAIResult{output:cleanAITerminalOutput(cmd.output,cmd.truncated),code:code}
    cmd.pending=nil
    cmd.finished=true
    cmd.done<-result
}

func cleanAITerminalOutput(p []byte, truncated bool) string {
    out:=strings.ToValidUTF8(string(p),"�")
    out=terminalAIOsc.ReplaceAllString(out,"")
    out=terminalAIColor.ReplaceAllString(out,"")
    out=strings.ReplaceAll(out,"\r","")
    out=strings.TrimSpace(out)
    if truncated {out+="\n[终端输出超过 64 KiB，已截断]"}
    return out
}
