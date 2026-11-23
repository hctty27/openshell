package sshclient

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/hctty27/openshell/internal/apperror"
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
	if value == "" || len(value)>8192 { return apperror.New("aiREPLInputInvalid", nil) }
	for _,ch:=range value {
		if ch == 0 || ch == '\r' || ch == 0x7f || ch == 0x1b || (!multiline && ch == '\n') ||
			(ch < 0x20 && ch != '\n' && ch != '\t') {
			return apperror.New("aiREPLControlCharacters", nil)
		}
	}
	return nil
}

func redisAICommand(command string) (string,error) {
	c:=strings.TrimSpace(command)
	if err:=validREPLText(c,false);err!=nil { return "",err }
	fields:=strings.Fields(c)
	if len(fields)==0 || !redisReadCommands[strings.ToUpper(fields[0])] {
		return "",apperror.New("aiRedisReadOnlyOnly", nil)
	}
	return c,nil
}

func validPsqlDatabaseName(value string) bool {
	if len(value) == 0 || len(value) > 63 {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		valid := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' ||
			c >= '0' && c <= '9' || c == '_' || c == '.' || c == '-'
		if !valid || i == 0 && (c == '.' || c == '-') {
			return false
		}
	}
	return true
}

func psqlAICommand(command string) (string,error) {
	c:=strings.TrimSpace(command)
	if err:=validREPLText(c,false);err!=nil { return "",err }
	if strings.HasPrefix(c,`\`) {
		fields:=strings.Fields(c)
		if len(fields)==0 { return "",apperror.New("aiPsqlMetaEmpty", nil) }
		switch fields[0] {
		case `\c`, `\connect`:
			if len(fields) != 2 || !validPsqlDatabaseName(fields[1]) ||
				strings.ContainsAny(c, ";|") || strings.Count(c, "\\") != 1 {
				return "", apperror.New("aiPsqlConnectSimpleNameOnly", nil)
			}
			return c, nil
		case `\d`,`\d+`,`\dt`,`\dt+`,`\di`,`\di+`,`\dn`,`\dn+`,`\dv`,`\dv+`,`\df`,`\df+`,`\l`,`\l+`,`\conninfo`:
			// Meta-commands cannot run shell commands or write server state.
			if strings.ContainsAny(c,";|") || strings.Count(c,"\\") != 1 {
				return "",apperror.New("aiPsqlMetaChained", nil)
			}
			return c,nil
		default:
			return "",apperror.New("aiPsqlReadOnlyMeta", nil)
		}
	}
	c=strings.TrimSpace(strings.TrimSuffix(c,";"))
	if err:=validateReadOnlySQL(c,"psql",psqlReadCommands);err!=nil {
		return "",apperror.Wrap("aiPsqlReadOnlyOnly", err, nil)
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
				return "",apperror.New("aiPythonInteractiveBlocked", nil)
			}
		}
		compileMode:="single"
		if strings.Contains(c,"\n") { compileMode="exec" }
		inner:="try:\n    exec(compile("+strconv.Quote(c)+", '<openshell-ai>', '"+compileMode+"'))\nfinally:\n    print("+strconv.Quote(marker)+")\n"
		return "exec("+strconv.Quote(inner)+")\r",nil
	}
	return "",apperror.New("aiREPLUnknownProgram", nil)
}

func replCompletionSource(program, marker string) (string,error) {
	if program != "redis" {
		return "",apperror.New("aiREPLNoCompletionMarker", nil)
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
	if !state.seenResult {
		for _,line:=range lines {
			row:=strings.TrimSpace(line)
			if row==state.marker || (state.program=="redis" && row==strconv.Quote(state.marker)) {
				state.seenResult=true
				break
			}
		}
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
			return apperror.New("aiREPLPromptChanged", nil)
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
			return apperror.New("aiTerminalReleased", nil)
		case <-ticker.C:
		}
	}
}

func (lease *AITerminalLease) runREPL(ctx context.Context,command string) (string,error) {
	if !lease.connection.readiness.programReady(lease.program) {
		return "",apperror.New("aiREPLNotAtPrompt", nil)
	}
	lease.mu.Lock()
	if lease.poisoned {
		lease.mu.Unlock()
		return "",apperror.New("aiTerminalStateUnknown", nil)
	}
	if lease.current!=nil {
		lease.mu.Unlock()
		return "",apperror.New("aiTerminalCommandRunning", nil)
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
			return "",apperror.New("aiTerminalReleased", nil)
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
			return "",apperror.New("aiRedisStateChanged", nil)
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
		// Same language-neutral form as ssh_exec and the shell terminal.
		return fmt.Sprintf("%s\nexit status: %d",result.output,result.code),nil
	case <-ctx.Done():
		lease.markFailed()
		lease.interrupt()
		return "",ctx.Err()
	case <-lease.closed:
		lease.markFailed()
		return "",apperror.New("aiTerminalReleased", nil)
	}
}
