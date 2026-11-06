package sshclient

import (
	"context"
	"regexp"
	"strings"
	"testing"
	"time"
)

func initREPLState(t *testing.T,r *terminalShellReadiness,launch,prompt,program string) {
	t.Helper()
	r.observe([]byte("root@hk:~# "))
	r.userInput([]byte(launch+"\r"))
	r.observe([]byte("\r\n"+prompt))
	r.mu.Lock()
	r.lastOutput=time.Now().Add(-time.Second)
	r.mu.Unlock()
	if err:=r.checkReady();err!=nil {t.Fatalf("%s prompt rejected: %v",program,err)}
	if r.readyProgram()!=program {t.Fatalf("want %s, got %s",program,r.readyProgram())}
}

func TestREPLPromptTransitions(t *testing.T) {
	cases:=[]struct{launch,prompt,program,continuation,next string}{
		{"redis-cli","127.0.0.1:6379> ","redis","(empty)","127.0.0.1:6379[2]> "},
		{"redis-cli","redis> ","redis","(empty)","redis> "},
		{"redis-cli -h 192.0.2.1 -p 6380","192.0.2.1:6380> ","redis","(empty)","192.0.2.1:6380[2]> "},
		{"python3 -q",">>> ","python","... ",">>> "},
		{"sudo -u postgres psql","postgres=> ","psql","postgres-> ","postgres=*> "},
		{"psql -U admin -d example","example=# ","psql","example'# ","example=!> "},
	}
	for _,tc:=range cases {
		t.Run(tc.launch,func(t *testing.T){
			var r terminalShellReadiness
			initREPLState(t,&r,tc.launch,tc.prompt,tc.program)
			r.userInput([]byte("incomplete"))
			r.observe([]byte("\r\n"+tc.continuation))
			if err:=r.checkReady();err==nil {t.Fatal("continuation was accepted")}
			r.observe([]byte("\r\n"+tc.next))
			r.mu.Lock()
			r.lastOutput=time.Now().Add(-time.Second)
			r.mu.Unlock()
			if err:=r.checkReady();err!=nil {t.Fatal(err)}
			r.observe([]byte("\r\nroot@hk:~# "))
			r.mu.Lock()
			r.lastOutput=time.Now().Add(-time.Second)
			r.mu.Unlock()
			if err:=r.checkReady();err!=nil || r.readyProgram()!="shell" {
				t.Fatalf("Shell recovery failed: %v",err)
			}
		})
	}
}

func TestREPLPromptRejectsWithoutLaunch(t *testing.T) {
	for _,prompt:=range []string{"127.0.0.1:6379> ","postgres=> ",">>> "} {
		var r terminalShellReadiness
		r.observe([]byte("root@hk:~# \r\n"+prompt))
		r.mu.Lock()
		r.lastOutput=time.Now().Add(-time.Second)
		r.mu.Unlock()
		if err:=r.checkReady();err==nil {t.Fatalf("untrusted prompt accepted: %s",prompt)}
	}
}

func TestREPLSourceValidation(t *testing.T) {
	cases:=[]struct{program,command string; valid bool}{
		{"redis","PING",true},
		{"redis","SCAN 0 MATCH user:* COUNT 100",true},
		{"redis","HGETALL cache:users",true},
		{"redis","SET a b",false},
		{"redis","MONITOR",false},
		{"redis","GET a\nDEL a",false},
		{"psql","SELECT * FROM pg_catalog.pg_tables LIMIT 10;",true},
		{"psql","\\dt",true},
		{"psql","\\d+ users",true},
		{"psql","\\conninfo",true},
		{"psql","\\! ls",false},
		{"psql","\\dt \\! ls",false},
		{"psql","DELETE FROM users",false},
		{"psql","SELECT 1; DROP TABLE users;",false},
		{"python","1+2",true},
		{"python","import json\nprint(json.dumps({'x': 1}))",true},
		{"python","exit()",false},
		{"python","input('password?')",false},
	}
	for _,tc:=range cases {
		t.Run(tc.program+"/"+tc.command,func(t *testing.T){
			got,err:=replSource(tc.program,tc.command,"OPEN_SHELL_AI_REPL_123")
			if tc.valid && (err!=nil || got=="") {t.Fatalf("query rejected: %v",err)}
			if !tc.valid && err==nil {t.Fatalf("unsafe query accepted: %q",got)}
		})
	}
}

func TestREPLMarkerAndPromptRequired(t *testing.T) {
	cases:=[]struct{program,prompt,result string}{
		{"redis","127.0.0.1:6379> ","\"OPEN_SHELL_AI_REPL_123\""},
		{"psql","postgres=> ","OPEN_SHELL_AI_REPL_123"},
		{"python",">>> ","OPEN_SHELL_AI_REPL_123"},
	}
	for _,tc:=range cases {
		cmd:=&terminalAICommand{
			done:make(chan terminalAIResult,1),
			repl:&replAIState{program:tc.program,marker:"OPEN_SHELL_AI_REPL_123"},
		}
		cmd.consumeREPL([]byte("result: 42\r\nSELECT 'OPEN_SHELL_AI_REPL_123' AS marker;\r\n"))
		select {case <-cmd.done:t.Fatal("echoed marker completed early");default:}
		cmd.consumeREPL([]byte(tc.result+"\r\n"))
		select {case <-cmd.done:t.Fatal("missing prompt completed early");default:}
		cmd.consumeREPL([]byte(tc.prompt))
		select {
		case res:=<-cmd.done:
			if res.code!=0 || !strings.Contains(res.output,"result: 42") ||
				strings.Contains(res.output,"OPEN_SHELL_AI_REPL_123") {t.Fatalf("bad result: %+v",res)}
		default:t.Fatalf("%s did not complete",tc.program)
		}
	}
}

func TestREPLLeaseUsesExistingPTY(t *testing.T) {
	cases:=[]struct{program,launch,prompt,command,result string}{
		{"redis","redis-cli","127.0.0.1:6379> ","PING","PONG"},
		{"psql","psql","postgres=> ","SELECT 1;","1"},
		{"python","python3 -q",">>> ","1+2","3"},
	}
	for _,tc:=range cases {
		t.Run(tc.program,func(t *testing.T){
			_,lease,input:=newAITestLease()
			lease.program=tc.program
			initREPLState(t,&lease.connection.readiness,tc.launch,tc.prompt,tc.program)
			input.onWrite=func(p []byte) {
				wire:=string(p)
				if strings.Contains(wire,"OpenShellAI;") {t.Errorf("Shell marker sent to %s",tc.program);return}
				marker:=regexp.MustCompile("OPEN_SHELL_AI_REPL_[a-f0-9]+").FindString(wire)
				if marker=="" {t.Errorf("missing marker: %q",wire);return}
				reply:=[]byte("\r\n"+tc.result+"\r\n"+marker+"\r\n"+tc.prompt)
				lease.connection.readiness.observe(reply)
				lease.Observe(reply)
			}
			ctx,cancel:=context.WithTimeout(context.Background(),time.Second)
			defer cancel()
			out,err:=lease.Run(ctx,tc.command)
			if err!=nil || !strings.Contains(out,tc.result) || !strings.Contains(out,"执行状态: 成功") {
				t.Fatalf("bad output %q, err %v",out,err)
			}
			lease.Release()
		})
	}
}

func TestREPLTimeoutPoisonsLease(t *testing.T) {
	_,lease,input:=newAITestLease()
	lease.program="redis"
	initREPLState(t,&lease.connection.readiness,"redis-cli","127.0.0.1:6379> ","redis")
	ctx,cancel:=context.WithTimeout(context.Background(),20*time.Millisecond)
	defer cancel()
	_,err:=lease.Run(ctx,"PING")
	if err==nil || !lease.Failed() || !strings.Contains(input.String(),string([]byte{3})) {
		t.Fatalf("expected timeout and Ctrl+C: %v",err)
	}
	if _,err:=lease.Run(context.Background(),"PING");err==nil {t.Fatal("poisoned lease permitted another command")}
	lease.Release()
}

func TestREPLErrorStatus(t *testing.T) {
	for _,tc:=range []struct{program,prompt,errorLine string}{
		{"redis","127.0.0.1:6379> ","(error) ERR unknown key"},
		{"psql","postgres=> ","ERROR: permission denied"},
		{"python",">>> ","Traceback (most recent call last):"},
	} {
		cmd:=&terminalAICommand{done:make(chan terminalAIResult,1),
			repl:&replAIState{program:tc.program,marker:"OPEN_SHELL_AI_REPL_123"}}
		cmd.consumeREPL([]byte(tc.errorLine+"\r\nOPEN_SHELL_AI_REPL_123\r\n"+tc.prompt))
		select {
		case res:=<-cmd.done:
			if res.code!=1 {t.Fatalf("%s failed query marked successful",tc.program)}
		default:t.Fatalf("%s did not complete",tc.program)
		}
	}
}


func TestRedisClusterLaunchFromEchoWhenInputHistoryIsUnavailable(t *testing.T) {
	var r terminalShellReadiness
	r.observe([]byte("root@localhost ~]# "))
	// Readline's history keys and transformed input paths are not a literal
	// redis-cli command, so userInput cannot always classify the program.
	r.userInput([]byte{27, '[', 'A', '\r'})
	if r.startedProgram != "" { t.Fatal("unexpected program classification") }

	r.observe([]byte("root@localhost ~]# redis-cli -c -p 6380 -h 10.10.10.70"))
	r.observe([]byte("\r\nWarning: Using a password with '-a' or '-u' option on the command line interface may not be safe.\r\n"))
	r.observe([]byte("10.10.10.70:6380> "))
	r.mu.Lock()
	r.lastOutput = time.Now().Add(-time.Second)
	r.mu.Unlock()
	if err := r.checkReady(); err != nil || r.readyProgram() != "redis" {
		t.Fatalf("expected Redis after launch echo, got %q, %v", r.readyProgram(), err)
	}

	r.userInput([]byte("get version_temp\r"))
	r.observe([]byte("-> Redirected to slot [5798] located at 10.10.10.70:6384\r\n(nil)\r\n10.10.10.70:6384> "))
	r.mu.Lock()
	r.lastOutput = time.Now().Add(-time.Second)
	r.mu.Unlock()
	if err := r.checkReady(); err != nil || !r.programReady("redis") {
		t.Fatalf("Redis cluster redirected prompt not ready: %v", err)
	}
}

func TestRedisLaunchEchoRecognizedWhenSplitAcrossChunks(t *testing.T) {
	var r terminalShellReadiness
	r.observe([]byte("root@localhost ~]# "))
	r.observe([]byte("\r\nroot@localhost ~]# redis-cli -c -p 63"))
	r.observe([]byte("80 -h 10.10.10.70\r"))
	r.observe([]byte("\n10.10.10.70:6380> "))
	r.mu.Lock()
	r.lastOutput = time.Now().Add(-time.Second)
	r.mu.Unlock()
	if err := r.checkReady(); err != nil || r.readyProgram() != "redis" {
		t.Fatalf("split launch echo was not recognized: %v", err)
	}
}

func TestRedisOldLaunchEchoCannotAuthorizeAfterShellRecovery(t *testing.T) {
	var r terminalShellReadiness
	r.observe([]byte("root@localhost ~]# redis-cli -h 10.10.10.70\r\n"))
	r.observe([]byte("10.10.10.70:6380> "))
	r.observe([]byte("\r\nroot@localhost ~]# "))
	r.mu.Lock()
	r.lastOutput = time.Now().Add(-time.Second)
	r.mu.Unlock()
	if err := r.checkReady(); err != nil || r.readyProgram() != "shell" {
		t.Fatalf("Shell recovery failed: %v",err)
	}
	r.observe([]byte("\r\n10.10.10.70:6384> "))
	r.mu.Lock()
	r.lastOutput = time.Now().Add(-time.Second)
	r.mu.Unlock()
	if err := r.checkReady(); err == nil {
		t.Fatal("stale Redis CLI echo must not authorize a later prompt")
	}
}

func TestRedisShellEchoMustHaveRecognizedPrompt(t *testing.T) {
	for _,line:=range []string{
		"redis-cli -c -p 6380",
		"INFO: redis-cli -c -p 6380",
		"root@localhost ~]# echo redis-cli",
		"root@localhost ~]# redis-cli-helper",
	} {
		if got:=replLaunchFromShellEcho(line);got!="" {
			t.Fatalf("untrusted launch echo accepted: %q => %s",line,got)
		}
	}
	if got:=replLaunchFromShellEcho("root@localhost ~]# redis-cli -c -p 6380");got!="redis" {
		t.Fatalf("valid echoed launch rejected: %s",got)
	}
}
