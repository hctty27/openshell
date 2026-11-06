package sshclient

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/hctty27/openshell/internal/domain"
)

// mysqlAIState tracks the completion query independently of the displayed
// terminal output. Echoed input is never treated as a completion marker.
type mysqlAIState struct {
	marker string
	tail []byte
	seenResult bool
}

func mysqlReadOnlyQuery(command string) (string, error) {
	query := strings.TrimSpace(command)
	if query == "" || len(query) > 8192 || strings.ContainsAny(query, "\r\x00") {
		return "", errors.New("SQL 内容无效或过长")
	}
	// Deliberately conservative: only one statement and no client-side
	// commands or comments. SQL is not a security boundary: server grants
	// remain authoritative.
	terminator := ";"
	switch {
	case strings.HasSuffix(query, "\\G"), strings.HasSuffix(query, "\\g"):
		terminator = query[len(query)-2:]
		query = strings.TrimSpace(query[:len(query)-2])
	case strings.HasSuffix(query, ";"):
		query = strings.TrimSpace(query[:len(query)-1])
	}
	if query == "" || strings.ContainsAny(query, ";\\") ||
		strings.Contains(query, "--") || strings.Contains(query, "/*") ||
		strings.Contains(query, "*/") || strings.Contains(query, "#") {
		return "", errors.New("MySQL 终端 AI 当前只支持不含注释或多语句的单条查询")
	}
	parts := strings.Fields(query)
	if len(parts) == 0 { return "", errors.New("SQL 为空") }
	switch strings.ToUpper(parts[0]) {
	case "SHOW", "DESCRIBE", "DESC", "SELECT", "EXPLAIN":
	default:
		return "", errors.New("MySQL 终端 AI 当前仅支持 SHOW、DESCRIBE、DESC、SELECT 和 EXPLAIN 查询")
	}
	upper := " " + strings.ToUpper(strings.Join(parts, " ")) + " "
	for _, forbidden := range []string{
		" INTO ", " FOR UPDATE ", " LOCK IN SHARE MODE ",
		" SLEEP(", " BENCHMARK(", " LOAD_FILE(", " EXPLAIN ANALYZE ",
	} {
		if strings.Contains(upper, forbidden) {
			return "", errors.New("当前 SQL 包含暂不支持的操作")
		}
	}
	return query + terminator, nil
}

func (cmd *terminalAICommand) consumeMySQL(p []byte) {
	state := cmd.mysql
	cmd.appendOutput(p)
	state.tail = append(state.tail, p...)
	if len(state.tail) > 8192 {
		state.tail = append([]byte(nil), state.tail[len(state.tail)-8192:]...)
	}
	visible := terminalAIOsc.ReplaceAllString(string(state.tail), "")
	visible = terminalAIColor.ReplaceAllString(visible, "")
	visible = strings.ReplaceAll(visible, "\r", "")
	lines := strings.Split(visible, "\n")
	if !state.seenResult {
		for _, line := range lines {
			// Only a MySQL result row is a valid marker. The echoed SELECT
			// containing the token must never complete the command.
			if strings.TrimSpace(line) == "| "+state.marker+" |" {
				state.seenResult = true
				break
			}
		}
	}
	if !state.seenResult { return }
	lastLine := lines[len(lines)-1]
	if !mysqlPromptPattern.MatchString(lastLine) && !mysqlCustomPromptPattern.MatchString(lastLine) {
		return
	}
	output := cleanAITerminalOutput(cmd.output, cmd.truncated)
	sentinel := "SELECT '" + state.marker + "' AS __openshell_ai_done;"
	if index := strings.Index(output, sentinel); index >= 0 {
		output = strings.TrimSpace(output[:index])
	}
	code := 0
	for _, line := range strings.Split(output, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "ERROR ") {
			code = 1
			break
		}
	}
	cmd.finished = true
	cmd.done <- terminalAIResult{output:output, code:code}
}

func (lease *AITerminalLease) runMySQL(ctx context.Context, command string) (string, error) {
	query, err := mysqlReadOnlyQuery(command)
	if err != nil { return "", err }
	lease.mu.Lock()
	if lease.poisoned {
		lease.mu.Unlock()
		return "", errors.New("终端命令状态不可确认，已暂停自动执行")
	}
	if lease.current != nil {
		lease.mu.Unlock()
		return "", errors.New("此终端已有一条 AI 命令正在执行")
	}
	marker := "OPEN_SHELL_AI_MYSQL_" + strings.ReplaceAll(domain.NewID(), "-", "")
	running := &terminalAICommand{
		done:make(chan terminalAIResult,1),
		mysql:&mysqlAIState{marker:marker},
	}
	lease.current = running
	lease.mu.Unlock()
	defer func() {
		lease.mu.Lock()
		if lease.current == running { lease.current = nil }
		lease.mu.Unlock()
	}()

	// Both statements run inside the user's current mysql client, reusing its
	// authenticated connection, selected database and transaction context.
	source := query + "\rSELECT '" + marker + "' AS __openshell_ai_done;\r"
	if err := lease.send([]byte(source)); err != nil {
		lease.markFailed()
		return "", err
	}
	select {
	case result := <-running.done:
		return fmt.Sprintf("%s\n退出状态: %d", result.output, result.code), nil
	case <-ctx.Done():
		lease.markFailed()
		lease.interrupt()
		return "", ctx.Err()
	case <-lease.closed:
		lease.markFailed()
		return "", errors.New("SSH 终端已经释放或断开")
	}
}

// MySQL only uses the visible PTY. It must never send the OSC Shell probe.
func (lease *AITerminalLease) Program() string { return lease.program }

