package sshclient

import (
    "context"
    "encoding/base64"
    "fmt"
    "strings"
    "sync"
    "testing"
    "time"

    "github.com/hctty27/openshell/internal/domain"
)

func TestAITerminalMarkerCrossesChunks(t *testing.T) {
    cmd := &terminalAICommand{
        marker: []byte("\x1b]777;OpenShellAI;nonce;"),
        done:make(chan terminalAIResult,1),
    }
    cmd.consume([]byte("command output\r\nnext \x1b]777;OpenShe"))
    cmd.consume([]byte("llAI;nonce;7\x07prompt"))
    result := <-cmd.done
    if result.code != 7 || !strings.Contains(result.output,"command output") ||
        strings.Contains(result.output,"OpenShellAI") {
        t.Fatalf("unexpected result: %#v",result)
    }
}

func TestAITerminalOutputIsBounded(t *testing.T) {
    cmd:=&terminalAICommand{
        marker:[]byte("\x1b]777;OpenShellAI;nonce;"),done:make(chan terminalAIResult,1),
    }
    cmd.consume([]byte(strings.Repeat("x",terminalAIOutputLimit+100)))
    cmd.consume([]byte("\x1b]777;OpenShellAI;nonce;0\x07"))
    result:=<-cmd.done
    if result.code!=0 || !strings.Contains(result.output,"已截断") ||
        len(result.output)>terminalAIOutputLimit+120 {
        t.Fatalf("unexpected output size %d or exit %d",len(result.output),result.code)
    }
}

type aiCaptureInput struct {
    mu sync.Mutex
    sent [][]byte
    onWrite func([]byte)
}
func (c *aiCaptureInput) Write(p []byte) (int,error) {
    c.mu.Lock()
    c.sent=append(c.sent,append([]byte(nil),p...))
    c.mu.Unlock()
    if c.onWrite!=nil {c.onWrite(p)}
    return len(p),nil
}
func (c *aiCaptureInput) String() string {
    c.mu.Lock()
    defer c.mu.Unlock()
    var s strings.Builder
    for _,p:=range c.sent {s.Write(p)}
    return s.String()
}

func newAITestLease() (*Manager,*AITerminalLease,*aiCaptureInput) {
    m:=NewManager(nil,nil)
    ref:=domain.ConnectionRef{TabID:"tab",SessionID:"session",Generation:2}
    input:=&aiCaptureInput{}
    c:=&connection{ref:ref,stdin:input}
    lease:=&AITerminalLease{manager:m,connection:c,ref:ref,closed:make(chan struct{})}
    c.aiController=lease
    m.connections[ref.TabID]=c
    return m,lease,input
}

func TestAITerminalRunUsesExistingPTYAndPreservesShellSyntax(t *testing.T) {
    _,lease,input:=newAITestLease()
    input.onWrite=func(p []byte) {
        source:=string(p)
        index:=strings.Index(source,"OpenShellAI;")
        if index<0 {return}
        token:=strings.SplitN(source[index+len("OpenShellAI;"):],";",2)[0]
        lease.Observe([]byte(fmt.Sprintf("done\x1b]777;OpenShellAI;%s;0\x07",token)))
    }
    ctx,cancel:=context.WithTimeout(context.Background(),time.Second)
    defer cancel()
    output,err:=lease.Run(ctx,"cd /tmp && pwd")
    if err!=nil {t.Fatal(err)}
    if !strings.Contains(output,"退出状态: 0") ||
        !strings.Contains(input.String(),"cd /tmp && pwd") {
        t.Fatalf("unexpected output=%s, input=%q",output,input.String())
    }
    lease.Release()
}

func TestAITerminalStopInterruptsAndBlocksLaterCommands(t *testing.T) {
    _,lease,input:=newAITestLease()
    ctx,cancel:=context.WithTimeout(context.Background(),20*time.Millisecond)
    defer cancel()
    _,err:=lease.Run(ctx,"sleep 60")
    if err==nil || !lease.Failed() {t.Fatalf("wanted failure, got %v",err)}
    if !strings.Contains(input.String(),string([]byte{3})) {
        t.Fatal("terminal timeout should send Ctrl+C")
    }
    if _,err:=lease.Run(context.Background(),"pwd");err==nil {t.Fatal("poisoned lease must reject further commands")}
    lease.Release()
}

func TestManagerWriteDoesNotOverwriteFastREPLPrompt(t *testing.T) {
	m := NewManager(nil, nil)
	ref := domain.ConnectionRef{TabID: "psql-tab", SessionID: "session", Generation: 1}
	input := &aiCaptureInput{}
	c := &connection{ref: ref, stdin: input}
	c.readiness.program = "psql"
	c.readiness.prompt = true
	c.readiness.lastOutput = time.Now().Add(-time.Second)
	input.onWrite = func([]byte) {
		c.readiness.observe([]byte("\r\nYou are now connected to database \"private-chat\" as user \"root\".\r\nprivate-chat=# "))
	}
	m.connections[ref.TabID] = c

	command := base64.StdEncoding.EncodeToString([]byte("\\c private-chat\r"))
	if err := m.Write(ref, command); err != nil {
		t.Fatal(err)
	}
	c.readiness.mu.Lock()
	c.readiness.lastOutput = time.Now().Add(-time.Second)
	c.readiness.mu.Unlock()
	if err := c.readiness.checkReady(); err != nil {
		t.Fatalf("fast psql prompt was overwritten by late input state: %v", err)
	}
	if got := c.readiness.readyProgram(); got != "psql" {
		t.Fatalf("expected psql to remain ready, got %q", got)
	}
}

func TestAITerminalLocksManualInput(t *testing.T) {
    m,lease,input:=newAITestLease()
    payload:=base64.StdEncoding.EncodeToString([]byte("echo manual\r"))
    if err:=m.Write(lease.ref,payload);err!=errAITerminalBusy {
        t.Fatalf("manual input was not locked: %v",err)
    }
    lease.Release()
    if err:=m.Write(lease.ref,payload);err!=nil {
        t.Fatalf("terminal input still locked after release: %v",err)
    }
    if !strings.Contains(input.String(),"echo manual") {t.Fatal("manual command did not resume")}
}
