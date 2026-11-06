package sshclient

import (
	"context"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestMySQLReadOnlyQuery(t *testing.T) {
	cases := []struct{
		input string
		want string
		valid bool
	}{
		{"SHOW CREATE TABLE t_user\\G", "SHOW CREATE TABLE t_user\\G", true},
		{"DESCRIBE t_s_area", "DESCRIBE t_s_area;", true},
		{"SELECT id FROM t_user LIMIT 5;", "SELECT id FROM t_user LIMIT 5;", true},
		{"EXPLAIN SELECT * FROM t_user", "EXPLAIN SELECT * FROM t_user;", true},
		{"SELECT 1; DROP TABLE t_user;", "", false},
		{"DELETE FROM t_user", "", false},
		{"SELECT 1 INTO OUTFILE '/tmp/example'", "", false},
		{"SELECT SLEEP(30)", "", false},
		{"EXPLAIN ANALYZE DELETE FROM t_user", "", false},
		{"\\! id", "", false},
		{"source /tmp/file.sql", "", false},
		{"SELECT 1 -- comment", "", false},
	}
	for _, tt := range cases {
		t.Run(tt.input,func(t *testing.T){
			got,err:=mysqlReadOnlyQuery(tt.input)
			if tt.valid && (err!=nil || got!=tt.want) { t.Fatalf("query=%q error=%v",got,err) }
			if !tt.valid && err==nil { t.Fatalf("unsafe query accepted: %q",got) }
		})
	}
}

func TestAITerminalMySQLUsesCurrentPTYAndIgnoresEchoedMarker(t *testing.T) {
	_,lease,input:=newAITestLease()
	lease.program="mysql"
	lease.connection.readiness.observe([]byte("Welcome to the MySQL monitor.\r\nmysql> "))
	input.onWrite=func(p []byte){
		source:=string(p)
		if strings.Contains(source,"printf") || !strings.HasPrefix(source,"SHOW CREATE TABLE t_user\\G\r") {
			t.Errorf("unexpected shell probe or input: %q",source)
			return
		}
		markerPattern:=regexp.MustCompile("OPEN_SHELL_AI_MYSQL_[a-f0-9]+")
		marker:=markerPattern.FindString(source)
		if marker=="" { t.Errorf("missing completion marker: %q",source);return }

		lease.Observe([]byte("mysql@localhost[example]> SHOW CREATE TABLE t_user\\G\r\nCreate Table: CREATE TABLE t_user (id bigint)\r\n"))
		// Echoed SELECT contains the token, but is not a result row.
		lease.Observe([]byte("mysql@localhost[example]> SELECT '"+marker+"' AS __openshell_ai_done;\r\n"))
		lease.mu.Lock()
		seen:=lease.current.mysql.seenResult
		lease.mu.Unlock()
		if seen { t.Error("echoed SQL must not count as successful completion") }
		lease.Observe([]byte("+----+\r\n| __openshell_ai_done |\r\n| "+marker+" |\r\n1 row in set (0.00 sec)\r\nmysql@localhost[example]> "))
	}
	ctx,cancel:=context.WithTimeout(context.Background(),time.Second)
	defer cancel()
	output,err:=lease.Run(ctx,"SHOW CREATE TABLE t_user\\G")
	if err!=nil { t.Fatal(err) }
	if !strings.Contains(output,"CREATE TABLE t_user") || !strings.Contains(output,"退出状态: 0") {
		t.Fatalf("unexpected output: %q",output)
	}
	if strings.Contains(output,"__openshell_ai_done") { t.Fatalf("completion query leaked into output: %q",output) }
	lease.Release()
}

func TestMySQLMarkerWaitsForResultAndPrompt(t *testing.T) {
	marker:="OPEN_SHELL_AI_MYSQL_abc123"
	cmd:=&terminalAICommand{
		done:make(chan terminalAIResult,1),
		mysql:&mysqlAIState{marker:marker},
	}
	cmd.consumeMySQL([]byte("mysql> SELECT '"+marker+"' AS __openshell_ai_done;\r\n"))
	select { case <-cmd.done: t.Fatal("echo unexpectedly completed command"); default: }
	cmd.consumeMySQL([]byte("| "+marker+" |"))
	select { case <-cmd.done: t.Fatal("missing prompt should not complete command"); default: }
	cmd.consumeMySQL([]byte("\r\n1 row in set\r\nmysql> "))
	select {
	case got:=<-cmd.done:
		if got.code!=0 { t.Fatalf("unexpected result: %+v",got) }
	default: t.Fatal("result row and prompt did not complete command")
	}
}

func TestMySQLTerminalReadinessRequiresBannerAndCompleteInput(t *testing.T) {
	var state terminalShellReadiness
	state.observe([]byte("mysql> "))
	state.mu.Lock()
	state.lastOutput=time.Now().Add(-time.Second)
	state.mu.Unlock()
	if err:=state.checkReady();err==nil {t.Fatal("bare mysql-like output must not authorize AI")}

	state.observe([]byte("\r\nWelcome to the MySQL monitor. Commands end with ; or \\g.\r\nmysql@localhost[db]> "))
	state.mu.Lock()
	state.lastOutput=time.Now().Add(-time.Second)
	state.mu.Unlock()
	if err:=state.checkReady();err!=nil {t.Fatal(err)}
	if state.readyProgram()!="mysql" {t.Fatal("wrong executor")}
	state.userInput([]byte("SELECT 1"))
	state.observe([]byte("\r\n    -> "))
	if err:=state.checkReady();err==nil {t.Fatal("MySQL continuation prompt must not be ready")}

	state.observe([]byte("\r\nmysql@localhost[db]> "))
	state.mu.Lock()
	state.lastOutput=time.Now().Add(-time.Second)
	state.mu.Unlock()
	if err:=state.checkReady();err!=nil {t.Fatal(err)}
	state.observe([]byte("\r\nroot@hk:~# "))
	state.mu.Lock()
	state.lastOutput=time.Now().Add(-time.Second)
	state.mu.Unlock()
	if err:=state.checkReady();err!=nil {t.Fatal(err)}
	if state.readyProgram()!="shell" {t.Fatal("must return to Shell executor after exit")}
}

func TestMySQLPromptOverridesStaleShellIntegrationMarker(t *testing.T) {
	var state terminalShellReadiness
	state.observe([]byte("\x1b]133;B\x07"))
	state.userInput([]byte("mysql\r"))
	state.observe([]byte("Welcome to the MySQL monitor.\r\nmysql> "))
	state.mu.Lock()
	state.lastOutput=time.Now().Add(-time.Second)
	state.mu.Unlock()
	if err:=state.checkReady();err!=nil {t.Fatal(err)}
	if state.readyProgram()!="mysql" {t.Fatal("Shell integration marker must not force Shell executor")}
}

func TestMySQLTerminalTimeoutInterruptsAndPreventsReuse(t *testing.T) {
	_,lease,input:=newAITestLease()
	lease.program="mysql"
	lease.connection.readiness.observe([]byte("Welcome to the MySQL monitor.\r\nmysql> "))
	ctx,cancel:=context.WithTimeout(context.Background(),20*time.Millisecond)
	defer cancel()
	if _,err:=lease.Run(ctx,"SELECT 1");err==nil { t.Fatal("expected timeout") }
	if !lease.Failed() || !strings.Contains(input.String(),string([]byte{3})) {
		t.Fatal("timed out query must be interrupted and lease marked failed")
	}
	if _,err:=lease.Run(context.Background(),"SELECT 2");err==nil {
		t.Fatal("poisoned MySQL lease unexpectedly allowed another command")
	}
	lease.Release()
}

func TestMySQLRejectedQueryNeverTouchesPTY(t *testing.T) {
	_,lease,input:=newAITestLease()
	lease.program="mysql"
	lease.connection.readiness.observe([]byte("Welcome to the MySQL monitor.\r\nmysql> "))
	if _,err:=lease.Run(context.Background(),"DROP TABLE t_user");err==nil {
		t.Fatal("DROP TABLE must be blocked")
	}
	if got:=input.String();got!="" {
		t.Fatalf("unsafe query wrote to terminal: %q",got)
	}
	lease.Release()
}

func TestMySQLExecutionReportsSQLError(t *testing.T) {
	marker:="OPEN_SHELL_AI_MYSQL_err"
	cmd:=&terminalAICommand{done:make(chan terminalAIResult,1),mysql:&mysqlAIState{marker:marker}}
	cmd.consumeMySQL([]byte("ERROR 1146 (42S02): Table doesn't exist\r\n"+
		"| "+marker+" |\r\n1 row in set (0.00 sec)\r\nmysql> "))
	select {
	case got:=<-cmd.done:
		if got.code!=1 { t.Fatalf("SQL failure not reflected in exit code: %+v",got) }
	default: t.Fatal("expected finished error result")
	}
}

func TestMySQLGreetingIsNotReplayedAfterExit(t *testing.T) {
	var state terminalShellReadiness
	state.observe([]byte("Welcome to the MySQL monitor.\r\nmysql> "))
	state.observe([]byte("\r\nroot@hk:~# "))
	state.mu.Lock()
	state.lastOutput=time.Now().Add(-time.Second)
	state.mu.Unlock()
	if err:=state.checkReady();err!=nil || state.readyProgram()!="shell" {
		t.Fatalf("expected Shell after exiting MySQL: %v",err)
	}
	state.observe([]byte("\r\nmysql> "))
	state.mu.Lock()
	state.lastOutput=time.Now().Add(-time.Second)
	state.mu.Unlock()
	if err:=state.checkReady();err==nil {
		t.Fatal("old greeting authorized MySQL prompt after client exited")
	}
}
