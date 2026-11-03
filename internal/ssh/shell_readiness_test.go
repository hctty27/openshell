package sshclient

import (
	"strings"
	"testing"
	"time"

	"github.com/hctty27/openshell/internal/domain"
	"golang.org/x/crypto/ssh"
)

func TestShellReadinessIntegrationEventsAreNotReplayed(t *testing.T) {
	var state terminalShellReadiness
	state.observe([]byte("\x1b]133;"))
	state.observe([]byte("B\x07"))
	if err := state.checkReady(); err != nil { t.Fatal(err) }

	state.userInput([]byte("pwd"))
	// Old marker is still in the lookbehind; it must not authorize input.
	state.observe([]byte("pwd\r\n"))
	if err := state.checkReady(); err == nil {
		t.Fatal("stale OSC 133 marker authorized typing into a busy shell")
	}
	state.observe([]byte("\x1b]133;C\x07"))
	if err := state.checkReady(); err == nil { t.Fatal("command started should be busy") }
	state.observe([]byte("\x1b]133;B\x07"))
	if err := state.checkReady(); err != nil { t.Fatal(err) }
}

func TestShellReadinessConservativePromptFallback(t *testing.T) {
	var state terminalShellReadiness
	state.observe([]byte("Last login: today\r\nroot@hk:~# "))
	state.mu.Lock()
	state.lastOutput = time.Now().Add(-time.Second)
	state.mu.Unlock()
	if err := state.checkReady(); err != nil { t.Fatal(err) }

	state.userInput([]byte("top\r"))
	if err := state.checkReady(); err == nil { t.Fatal("manual input did not invalidate prompt") }

	state.observe([]byte("top output\r\n"))
	if err := state.checkReady(); err == nil { t.Fatal("process output was mistaken for a prompt") }
	state.observe([]byte("\r\nroot@hk:~# "))
	state.mu.Lock()
	state.lastOutput = time.Now().Add(-time.Second)
	state.mu.Unlock()
	if err := state.checkReady(); err != nil { t.Fatal(err) }
}

func TestShellReadinessRejectsAmbiguousOutputAndAlternateBuffer(t *testing.T) {
	var state terminalShellReadiness
	state.observe([]byte("root@hk:~# output\r\n# "))
	state.mu.Lock()
	state.lastOutput = time.Now().Add(-time.Second)
	state.mu.Unlock()
	if err := state.checkReady(); err == nil { t.Fatal("bare # must not be considered reliable") }

	state.observe([]byte("\x1b]133;B\x07"))
	state.observe([]byte("\x1b[?1049h"))
	if err := state.checkReady(); err == nil || !strings.Contains(err.Error(), "全屏") {
		t.Fatalf("alternate buffer must block AI takeover, got %v", err)
	}
	state.observe([]byte("\x1b[?1049l\x1b]133;B\x07"))
	if err := state.checkReady(); err != nil { t.Fatal(err) }
}

type aiReadyFilter struct{}

func (aiReadyFilter) Close() {}
func (aiReadyFilter) SetTerminalColumns(int32) {}
func (aiReadyFilter) IsTransferringFiles() bool { return false }
func (aiReadyFilter) StopTransferringFiles(bool) {}

func TestAcquireAITerminalRejectsUnknownStateWithoutWriting(t *testing.T) {
	m := NewManager(nil,nil)
	ref := domain.ConnectionRef{TabID:"test", SessionID:"session", Generation:1}
	input := &aiCaptureInput{}
	c := &connection{ref:ref,terminal:&ssh.Session{},stdin:input,filter:aiReadyFilter{}}
	m.connections[ref.TabID] = c

	if _,err:=m.AcquireAITerminal(ref);err==nil {
		t.Fatal("uncertain shell state must reject AI takeover")
	}
	if got:=input.String();got!="" {
		t.Fatalf("readiness check wrote to terminal: %q",got)
	}
	c.readiness.observe([]byte("\x1b]133;B\x07"))
	lease,err:=m.AcquireAITerminal(ref)
	if err!=nil { t.Fatal(err) }
	lease.Release()
}
