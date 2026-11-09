package sshclient

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/hctty27/openshell/internal/domain"
)

// replAIState uses a different completion grammar for each interactive client.
// A returned prompt without the sentinel is never sufficient to finish a task.
type replAIState struct {
	program string
	marker string
	tail []byte
	seenResult bool
	commandPrompt chan struct{}
	commandPromptSeen bool
	markerSent bool
}

var redisReadCommands = map[string]bool{
	"PING":true, "INFO":true, "DBSIZE":true, "TIME":true, "ROLE":true,
	"GET":true, "MGET":true, "STRLEN":true, "EXISTS":true, "TYPE":true,
	"TTL":true, "PTTL":true, "SCAN":true, "HSCAN":true, "SSCAN":true,
	"ZSCAN":true, "HGET":true, "HMGET":true, "HGETALL":true,
	"HEXISTS":true, "HKEYS":true, "HVALS":true, "HLEN":true,
	"LLEN":true, "LRANGE":true, "LINDEX":true, "SCARD":true,
	"SISMEMBER":true, "SMEMBERS":true, "SRANDMEMBER":true,
	"ZCARD":true, "ZRANGE":true, "ZSCORE":true, "ZCOUNT":true,
	"XLEN":true, "XRANGE":true, "XREVRANGE":true,
}
var psqlReadCommands = map[string]bool{
	"SELECT":true, "SHOW":true, "EXPLAIN":true,
	"TABLE":true, "VALUES":true,
}

func validREPLText(value string, multiline bool) error {
	if value == "" || len(value)>8192 { return errors.New("交互命令内容为空或过长") }
	for _,ch:=range value {
		if ch == 0 || ch == '\r' || ch == 0x7f || ch == 0x1b || (!multiline && ch == '\n') ||
			(ch < 0x20 && ch != '\n' && ch != '\t') {
			return errors.New("交互命令包含不允许的控制字符")
		}
	}
	return nil
}

func redisAICommand(command string) (string,error) {
	c:=strings.TrimSpace(command)
	if err:=validREPLText(c,false);err!=nil { return "",err }
	fields:=strings.Fields(c)
	if len(fields)==0 || !redisReadCommands[strings.ToUpper(fields[0])] {
		return "",errors.New("Redis 终端 AI 当前只支持白名单内的只读命令（如 INFO、SCAN、GET、HGETALL）")
	}
	return c,nil
}

func psqlAICommand(command string) (string,error) {
	c:=strings.TrimSpace(command)
	if err:=validREPLText(c,false);err!=nil { return "",err }
	if strings.HasPrefix(c,`\`) {
		fields:=strings.Fields(c)
		if len(fields)==0 { return "",errors.New("psql 元命令为空") }
		switch fields[0] {
		case `\d`,`\d+`,`\dt`,`\dt+`,`\di`,`\di+`,`\dn`,`\dn+`,`\dv`,`\dv+`,`\df`,`\df+`,`\l`,`\l+`,`\conninfo`:
			// Meta-commands cannot run shell commands or write server state.
			if strings.ContainsAny(c,";|") || strings.Count(c,"\\") != 1 {
				return "",errors.New("psql 元命令不支持链式执行")
			}
			return c,nil
		default:
			return "",errors.New("当前仅支持 psql 只读元命令（如 \\d、\\dt、\\conninfo）")
		}
	}
	if (strings.Contains(c,";") || strings.Contains(c,`\`)) || strings.Contains(c,"--") || strings.Contains(c,"/*") || strings.Contains(c,"*/") {
		if !strings.HasSuffix(c,";") || (strings.Contains(strings.TrimSuffix(c,";"),";") || strings.Contains(strings.TrimSuffix(c,";"),`\`)) || strings.Contains(c,"--") || strings.Contains(c,"/*") || strings.Contains(c,"*/") {
			return "",errors.New("psql 当前仅支持无注释的单条只读 SQL")
		}
		c=strings.TrimSuffix(c,";")
	}
	fields:=strings.Fields(c)
	if len(fields)==0 || !psqlReadCommands[strings.ToUpper(fields[0])] {
		return "",errors.New("psql 当前仅支持 SELECT、SHOW、EXPLAIN、TABLE、VALUES 和只读元命令")
	}
	upper:=" "+strings.ToUpper(strings.Join(fields," "))+" "
	for _,blocked:=range []string{
		" INTO ", " FOR UPDATE ", " FOR SHARE ", " PG_SLEEP(", " PG_READ_FILE(",
		" PG_WRITE_FILE(", " PG_TERMINATE_BACKEND(", " EXPLAIN ANALYZE ",
	} {
		if strings.Contains(upper,blocked) { return "",errors.New("当前 SQL 包含暂不支持的操作") }
	}
	return strings.TrimSpace(c)+";",nil
}

func replSource(program, command, marker string) (string,error) {
	switch program {
	case "redis":
		c,err:=redisAICommand(command)
		if err!=nil { return "",err }
		return c+"\r",nil
	case "psql":
		c,err:=psqlAICommand(command)
		if err!=nil { return "",err }
		return c+"\rSELECT '"+marker+"' AS __openshell_ai_done;\r",nil
	case "python":
		c:=strings.TrimSpace(command)
		if err:=validREPLText(c,true);err!=nil { return "",err }
		lower:=strings.ToLower(c)
		for _,blocked:=range []string{"exit(", "quit(", "input(", "breakpoint(", "getpass(", "os._exit("} {
			if strings.Contains(lower,blocked) {
				return "",errors.New("Python 当前不支持退出解释器或等待人工交互的操作")
			}
		}
		compileMode:="single"
		if strings.Contains(c,"\n") { compileMode="exec" }
		inner:="try:\n    exec(compile("+strconv.Quote(c)+", '<openshell-ai>', '"+compileMode+"'))\nfinally:\n    print("+strconv.Quote(marker)+")\n"
		return "exec("+strconv.Quote(inner)+")\r",nil
	}
	return "",errors.New("未知交互程序")
}

func replCompletionSource(program, marker string) (string,error) {
	if program != "redis" {
		return "",errors.New("当前交互程序不支持独立结束标记")
	}
	return "ECHO "+marker+"\r",nil
}

func lastNonEmptyREPLLine(lines []string) string {
	for i:=len(lines)-1;i>=0;i-- {
		if line:=strings.TrimSpace(lines[i]);line!="" {
			return line
		}
	}
	return ""
}

func matchREPLCompletionPrompt(program,line string) bool {
	switch program {
	case "redis": return redisPromptPattern.MatchString(line)
	case "python": return line==">>> " || line==">>>"
	case "psql": return psqlPromptPattern.MatchString(line)
	}
	return false
}

func (cmd *terminalAICommand) consumeREPL(p []byte) {
	state:=cmd.repl
	cmd.appendOutput(p)
	state.tail=append(state.tail,p...)
	if len(state.tail)>8192 {
		state.tail=append([]byte(nil),state.tail[len(state.tail)-8192:]...)
	}
	visible:=terminalAIOsc.ReplaceAllString(string(state.tail),"")
	visible=terminalAIColor.ReplaceAllString(visible,"")
	visible=strings.ReplaceAll(visible,"\r","")
	lines:=strings.Split(visible,"\n")
	if !state.seenResult {
		for _,line:=range lines {
			row:=strings.TrimSpace(line)
			if row==state.marker || (state.program=="redis" && row==strconv.Quote(state.marker)) {
				state.seenResult=true
				break
			}
		}
	}
	if state.program=="redis" && !state.markerSent {
		if !state.commandPromptSeen && matchREPLCompletionPrompt("redis",lastNonEmptyREPLLine(lines)) {
			state.commandPromptSeen=true
			if state.commandPrompt!=nil {
				select {
				case state.commandPrompt<-struct{}{}:
				default:
				}
			}
		}
		return
	}
	if !state.seenResult || !matchREPLCompletionPrompt(state.program,lastNonEmptyREPLLine(lines)) {return}
	output:=cleanAITerminalOutput(cmd.output,cmd.truncated)
	var cleaned []string
	code:=0
	for _,line:=range strings.Split(output,"\n") {
		trimmed:=strings.TrimSpace(line)
		if strings.Contains(line,state.marker) {continue}
		if matchREPLCompletionPrompt(state.program,line) {continue}
		switch state.program {
		case "redis":
			if strings.HasPrefix(trimmed,"(error)") || strings.HasPrefix(trimmed,"ERR ") {code=1}
		case "psql":
			if strings.HasPrefix(trimmed,"ERROR:") || strings.HasPrefix(trimmed,"FATAL:") {code=1}
		case "python":
			if strings.HasPrefix(trimmed,"Traceback (most recent call last)") ||
				strings.HasPrefix(trimmed,"SyntaxError:") {code=1}
		}
		cleaned=append(cleaned,line)
	}
	cmd.finished=true
	cmd.done<-terminalAIResult{output:strings.TrimSpace(strings.Join(cleaned,"\n")),code:code}
}

func (lease *AITerminalLease) waitForREPLPrompt(ctx context.Context) error {
	ticker:=time.NewTicker(25*time.Millisecond)
	defer ticker.Stop()
	for {
		if lease.connection.readiness.readyProgram()!=lease.program {
			return errors.New("交互程序已退出或提示符发生变化，无法确认命令结束")
		}
		if lease.connection.readiness.programReady(lease.program) {
			if err:=lease.connection.readiness.checkReady();err==nil {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-lease.closed:
			return errors.New("SSH 终端已释放或断开")
		case <-ticker.C:
		}
	}
}

func (lease *AITerminalLease) runREPL(ctx context.Context,command string) (string,error) {
	if !lease.connection.readiness.programReady(lease.program) {
		return "",errors.New("交互程序未处于空白主提示符，请等待上一条命令结束")
	}
	lease.mu.Lock()
	if lease.poisoned {
		lease.mu.Unlock()
		return "",errors.New("终端状态不可确认，已停止自动执行")
	}
	if lease.current!=nil {
		lease.mu.Unlock()
		return "",errors.New("此终端已有一条 AI 命令正在执行")
	}
	marker:="OPEN_SHELL_AI_REPL_"+strings.ReplaceAll(domain.NewID(),"-","")
	source,err:=replSource(lease.program,command,marker)
	if err!=nil {lease.mu.Unlock();return "",err}
	replState:=&replAIState{program:lease.program,marker:marker}
	if lease.program=="redis" {
		replState.commandPrompt=make(chan struct{},1)
	}
	running:=&terminalAICommand{
		done:make(chan terminalAIResult,1),
		repl:replState,
	}
	lease.current=running
	lease.mu.Unlock()
	defer func(){
		lease.mu.Lock()
		if lease.current==running {lease.current=nil}
		lease.mu.Unlock()
	}()

	lease.connection.readiness.aiREPLInputStarted()
	if err:=lease.send([]byte(source));err!=nil {
		lease.markFailed()
		return "",err
	}
	if lease.program=="redis" {
		select {
		case <-running.repl.commandPrompt:
		case <-ctx.Done():
			lease.markFailed()
			lease.interrupt()
			return "",ctx.Err()
		case <-lease.closed:
			lease.markFailed()
			return "",errors.New("SSH 终端已释放或断开")
		}
		if err:=lease.waitForREPLPrompt(ctx);err!=nil {
			lease.markFailed()
			if ctx.Err()!=nil {lease.interrupt()}
			return "",err
		}
		markerSource,err:=replCompletionSource(lease.program,marker)
		if err!=nil {
			lease.markFailed()
			return "",err
		}
		lease.mu.Lock()
		if lease.current!=running || running.finished {
			lease.mu.Unlock()
			lease.markFailed()
			return "",errors.New("Redis 终端执行状态已变化，已停止继续操作")
		}
		running.repl.markerSent=true
		lease.mu.Unlock()
		lease.connection.readiness.aiREPLInputStarted()
		if err:=lease.send([]byte(markerSource));err!=nil {
			lease.markFailed()
			return "",err
		}
	}
	select {
	case result:=<-running.done:
		status:="成功"
		if result.code!=0 {status="失败"}
		return fmt.Sprintf("%s\n执行状态: %s",result.output,status),nil
	case <-ctx.Done():
		lease.markFailed()
		lease.interrupt()
		return "",ctx.Err()
	case <-lease.closed:
		lease.markFailed()
		return "",errors.New("SSH 终端已释放或断开")
	}
}
