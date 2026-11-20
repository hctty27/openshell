package sshclient

import (
	"bytes"
	"strings"
	"testing"

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
		if strings.Contains(string(p),"OpenShellPassiveHookChallenge") {
			bootstrap=string(p)
			if _,err:=filter.Write([]byte(nativePassiveBashHookChallenge));err!=nil{return 0,err}
		} else {
			nonceWrite=string(p)
			if _,err:=filter.Write([]byte(nativePassiveBashHookReady));err!=nil{return 0,err}
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
	if output.Len()!=0 {t.Fatalf("private challenge/READY leaked into xterm: %q",output.String())}
	// After registration, plain prompt OSC markers must be hidden from the
	// frontend history and from Shell readiness output.
	marker:=[]byte("\x1b]777;OpenShellNativeZmodem;"+token+";0\x07")
	if _,err:=filter.Write(marker);err!=nil {t.Fatal(err)}
	if output.Len()!=0 {t.Fatalf("private token leaked into output: %q",output.String())}
}
