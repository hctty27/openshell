package sshclient

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/hctty27/openshell/internal/domain"
	"golang.org/x/crypto/ssh"
)

type nativePassiveHookInputFunc func([]byte)(int,error)
func (fn nativePassiveHookInputFunc) Write(p []byte)(int,error) {return fn(p)}

func TestNativePassiveBashInstallerRegistersTokenBeforeTransfer(t *testing.T) {
	m:=NewManager(keys{},nil)
	ref:=domain.ConnectionRef{TabID:"passive-bash-setup",SessionID:"session",Generation:9}
	var output bytes.Buffer
	filter:=newNativePassiveBashHookFilter(&output)
	c:=&connection{ref:ref,terminal:&ssh.Session{},passiveBashHookFilter:filter,
		passiveBashHookInstalling:true}
	c.readiness.observe([]byte("user@host:~$ "))
	var bootstrap, nonceWrite string
	wire:=nativePassiveHookInputFunc(func(p []byte)(int,error){
		if strings.Contains(string(p),"OpenShellPassiveHookProbe") {
			// Bash echoes the probe line, then answers with its version.
			if _,err:=filter.Write(append(append([]byte{},p...),[]byte("\n"+nativePassiveBashHookProbePrefix+"5.1.16(1)-release\x07user@host:~$ ")...));err!=nil{return 0,err}
		} else if strings.Contains(string(p),"OpenShellPassiveHookChallenge") {
			if _,err:=filter.Write([]byte(string(p)+"\n"));err!=nil{return 0,err}
			bootstrap=string(p)
			if _,err:=filter.Write([]byte(nativePassiveBashHookChallenge));err!=nil{return 0,err}
		} else {
			nonceWrite=string(p)
			if _,err:=filter.Write([]byte(nativePassiveBashHookReady+"user@host:~$ "));err!=nil{return 0,err}
		}
		return len(p),nil
	})
	c.inputGate=newTerminalInputGate(wire,wire)
	m.mu.Lock()
	m.connections[ref.TabID]=c
	m.generations[ref.TabID]=ref.Generation
	m.mu.Unlock()
	m.installNativePassiveBashHook(ref,c)
	m.mu.Lock()
	token,installing,poisoned:=c.passiveBashHookToken,c.passiveBashHookInstalling,c.nativeTerminalPoisoned
	m.mu.Unlock()
	if installing||poisoned||len(token)!=32 {t.Fatalf("Bash hook did not register: token=%q installing=%v poisoned=%v",token,installing,poisoned)}
	if nonceWrite!=token+"\r"||strings.Contains(bootstrap,token) {
		t.Fatal("nonce was not sent in a separate, hidden input write")
	}
	// The echoed probe and bootstrap are hidden; the line is cleared and
	// only the new prompt is shown.
	if output.String()!=nativeHookCaptureEnd+"user@host:~$ " {t.Fatalf("setup output leaked into xterm: %q",output.String())}
	output.Reset()
	// After registration, plain prompt OSC markers must be hidden from the
	// frontend history and from Shell readiness output.
	marker:=[]byte("\x1b]777;OpenShellNativeZmodem;"+token+";0\x07")
	if _,err:=filter.Write(marker);err!=nil {t.Fatal(err)}
	if output.Len()!=0 {t.Fatalf("private token leaked into output: %q",output.String())}
}


func TestNativePassiveBashInstallerDeniedInputLeaseDoesNotStrandSetupLock(t *testing.T) {
	events:=make(chan map[string]any,2)
	m:=NewManager(keys{},func(name string,payload any){
		if name=="ssh:native-zmodem-shell-setup" {
			if v,ok:=payload.(map[string]any);ok {events<-v}
		}
	})
	ref:=domain.ConnectionRef{TabID:"denied-bash",SessionID:"session",Generation:1}
	var terminal bytes.Buffer
	input:=newTerminalInputGate(&terminal,&terminal)
	lease,err:=input.takeover()
	if err!=nil {t.Fatal(err)}
	c:=&connection{
		ref:ref,terminal:&ssh.Session{},inputGate:input,
		passiveBashHookFilter:newNativePassiveBashHookFilter(&terminal),
		passiveBashHookInstalling:true,
	}
	m.mu.Lock()
	m.connections[ref.TabID]=c
	m.mu.Unlock()
	m.installNativePassiveBashHook(ref,c)
	m.mu.Lock()
	installing,poisoned,token:=c.passiveBashHookInstalling,c.nativeTerminalPoisoned,c.passiveBashHookToken
	m.mu.Unlock()
	if installing||poisoned||token!="" {
		t.Fatalf("failed input lease left invalid hook state: installing=%v poisoned=%v token=%q",installing,poisoned,token)
	}
	select {
	case e:=<-events:
		if e["active"]!=false||e["ready"]!=false {t.Fatalf("wrong setup unlock event: %v",e)}
	default: t.Fatal("denied hook lease never released frontend setup event")
	}
	if err:=input.restore(lease);err!=nil {t.Fatal(err)}
}

// B1: a shell that is not Bash (dash, zsh, sh, fish) answers the probe with an
// empty version. The Bash bootstrap is never sent and the terminal is neither
// poisoned nor reported as unsupported.
func TestNativePassiveBashInstallerSkipsNonBashShell(t *testing.T) {
	for _, tc := range []struct{ name, answer, want string }{
		{"dash", nativePassiveBashHookProbePrefix + "\x07", nativeHookCaptureEnd + "$ "},
		// fish 2 or a broken shell never answers: show what it printed.
		{"no answer", "fish: Unknown command\n", " probe-echo\r\nfish: Unknown command\n$ "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var unsupported []any
			m:=NewManager(keys{},func(name string,payload any){
				if name=="ssh:native-zmodem-unsupported" {unsupported=append(unsupported,payload)}
			})
			ref:=domain.ConnectionRef{TabID:"passive-nonbash-"+tc.name,SessionID:"session",Generation:2}
			var output bytes.Buffer
			filter:=newNativePassiveBashHookFilter(&output)
			c:=&connection{ref:ref,terminal:&ssh.Session{},passiveBashHookFilter:filter,passiveBashHookInstalling:true}
			c.readiness.observe([]byte("dash2@host:~$ "))
			var writes []string
			wire:=nativePassiveHookInputFunc(func(p []byte)(int,error){
				writes=append(writes,string(p))
				if strings.Contains(string(p),"OpenShellPassiveHookProbe") {
					echo:=" probe-echo\r\n"
					if tc.name=="dash" {echo=string(p)+"\n"}
					if _,err:=filter.Write([]byte(echo+tc.answer+"$ "));err!=nil{return 0,err}
				}
				return len(p),nil
			})
			c.inputGate=newTerminalInputGate(wire,wire)
			m.mu.Lock()
			m.connections[ref.TabID]=c
			m.generations[ref.TabID]=ref.Generation
			m.mu.Unlock()
			m.installNativePassiveBashHook(ref,c)
			m.mu.Lock()
			token,installing,poisoned:=c.passiveBashHookToken,c.passiveBashHookInstalling,c.nativeTerminalPoisoned
			m.mu.Unlock()
			if installing||poisoned||token!=""||len(unsupported)!=0 {
				t.Fatalf("non-Bash shell changed state: token=%q installing=%v poisoned=%v unsupported=%v",token,installing,poisoned,unsupported)
			}
			if len(writes)!=1 {t.Fatalf("Bash bootstrap was sent to a non-Bash shell: %q",writes)}
			if output.String()!=tc.want {t.Fatalf("unexpected terminal output %q",output.String())}
			if _,err:=c.inputGate.Write([]byte("ls\r"));err!=nil {t.Fatalf("terminal input stayed locked: %v",err)}
		})
	}
}

// A Bash that never acknowledges the bootstrap gets Ctrl-C (ending a hidden
// read -s) and the terminal stays usable instead of being poisoned.
func TestNativePassiveBashInstallerInterruptsUnacknowledgedBootstrap(t *testing.T) {
	m:=NewManager(keys{},nil)
	ref:=domain.ConnectionRef{TabID:"passive-bash-silent",SessionID:"session",Generation:3}
	var output bytes.Buffer
	filter:=newNativePassiveBashHookFilter(&output)
	c:=&connection{ref:ref,terminal:&ssh.Session{},passiveBashHookFilter:filter,passiveBashHookInstalling:true}
	c.readiness.observe([]byte("user@host:~$ "))
	var writes []string
	wire:=nativePassiveHookInputFunc(func(p []byte)(int,error){
		writes=append(writes,string(p))
		if strings.Contains(string(p),"OpenShellPassiveHookProbe") {
			_,_=filter.Write([]byte(nativePassiveBashHookProbePrefix+"5.2\x07"))
		}
		return len(p),nil
	})
	c.inputGate=newTerminalInputGate(wire,wire)
	m.mu.Lock()
	m.connections[ref.TabID]=c
	m.generations[ref.TabID]=ref.Generation
	m.mu.Unlock()
	started:=time.Now()
	m.installNativePassiveBashHook(ref,c)
	if time.Since(started)>nativePassiveBashInstallTimeout+2*time.Second {t.Fatal("installer did not give up")}
	m.mu.Lock()
	token,poisoned:=c.passiveBashHookToken,c.nativeTerminalPoisoned
	m.mu.Unlock()
	if poisoned||token!="" {t.Fatalf("unacknowledged bootstrap poisoned the terminal: token=%q poisoned=%v",token,poisoned)}
	if len(writes)!=3||writes[2]!="\x03" {t.Fatalf("bootstrap was not interrupted: %q",writes)}
}
