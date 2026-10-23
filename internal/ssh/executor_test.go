package sshclient

import (
	"context"
	"errors"
	"github.com/hctty27/openshell/internal/domain"
	"github.com/hctty27/openshell/internal/testssh"
	"strconv"
	"strings"
	"testing"
	"time"
)

func connected(t *testing.T) (*Manager, domain.ConnectionRef) {
	s := testssh.Start(t)
	m := NewManager(keys{}, nil)
	t.Cleanup(m.Close)
	row := domain.Session{ID: "a", Host: s.Host, Port: s.Port, Username: "root"}
	_, e := m.Connect(context.Background(), "tab", row, AuthInput{Password: "test-password"})
	var h *HostKeyError
	errors.As(e, &h)
	m.keys.Trust(h.Address, h.Key)
	ref, e := m.Connect(context.Background(), "tab", row, AuthInput{Password: "test-password"})
	if e != nil {
		t.Fatal(e)
	}
	return m, ref
}
// Integration tests spawn an actual shell; Windows CI runners may need time
// to create the process under concurrent test load. Only timeout-specific
// tests below use intentionally short deadlines.
const normalExecTestTimeout = 8 * time.Second

func TestExecExitCode(t *testing.T) {
	m, r := connected(t)
	v, e := m.Run(context.Background(), r, "printf hello; printf error >&2; exit 7", "/tmp", normalExecTestTimeout)
	if e != nil || v.ExitCode == nil || *v.ExitCode != 7 || v.Stdout != "hello" || v.Stderr != "error" || v.Status != "failed" {
		t.Fatalf("%+v %v", v, e)
	}
}
func TestExecOutputCap(t *testing.T) {
	m, r := connected(t)
	v, e := m.Run(context.Background(), r, "head -c 300000 /dev/zero", "/tmp", normalExecTestTimeout)
	if e != nil || !v.Truncated || len(v.Stdout)+len(v.Stderr) > 262144 {
		t.Fatalf("%+v %v", v, e)
	}
}
func TestExecTimeoutUnknown(t *testing.T) {
	m, r := connected(t)
	v, _ := m.Run(context.Background(), r, "sleep 2", "/tmp", time.Millisecond*30)
	if v.Status != "unknown" || v.Reason != "timed_out" {
		t.Fatal(v)
	}
}
func TestExecStdinClosed(t *testing.T) {
	m, r := connected(t)
	v, e := m.Run(context.Background(), r, "read value; echo done", "/tmp", normalExecTestTimeout)
	if e != nil || !strings.Contains(v.Stdout, "done") {
		t.Fatalf("%+v %v", v, e)
	}
}
func TestShellQuotedWorkingDirectory(t *testing.T) {
	m, r := connected(t)
	dir := "/tmp/openshell-quote' space; echo wrong-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	setup, e := m.Run(context.Background(), r, "mkdir -p -- "+QuoteShell(dir), "/tmp", normalExecTestTimeout)
	if e != nil || setup.Status != "completed" {
		t.Fatalf("remote test directory setup failed: %+v %v", setup, e)
	}
	defer m.Run(context.Background(), r, "rm -rf -- "+QuoteShell(dir), "/tmp", normalExecTestTimeout)
	v, e := m.Run(context.Background(), r, "pwd", dir, normalExecTestTimeout)
	if e != nil || strings.TrimSpace(v.Stdout) != dir {
		t.Fatalf("%+v %v", v, e)
	}
}
func TestFailedWorkingDirectoryDoesNotRunAnyScriptCommands(t *testing.T) {
	m, r := connected(t)
	v, e := m.Run(context.Background(), r, "printf FIRST; printf UNSAFE", "/definitely-missing-openshell-directory", normalExecTestTimeout)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(v.Stdout, "UNSAFE") {
		t.Fatal("script continued after cwd failed")
	}
	if v.ExitCode == nil || *v.ExitCode == 0 {
		t.Fatal(v)
	}
}
func TestExecTimeoutCoversChannelOpenAndStart(t *testing.T) {
	for _, mode := range []string{"open", "start"} {
		t.Run(mode, func(t *testing.T) {
			server := testssh.StartWithMode(t, mode)
			m := NewManager(keys{}, nil)
			defer m.Close()
			row := domain.Session{ID: "a", Host: server.Host, Port: server.Port, Username: "root"}
			_, e := m.Connect(context.Background(), "a", row, AuthInput{Password: "test-password"})
			var h *HostKeyError
			errors.As(e, &h)
			m.keys.Trust(h.Address, h.Key)
			ref, e := m.Connect(context.Background(), "a", row, AuthInput{Password: "test-password"})
			if e != nil {
				t.Fatal(e)
			}
			done := make(chan domain.CommandResult, 1)
			go func() { r, _ := m.Run(context.Background(), ref, "pwd", "/tmp", 30*time.Millisecond); done <- r }()
			select {
			case r := <-done:
				if r.Status != "unknown" || r.Reason != "timed_out" {
					t.Fatal(r)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("timeout does not cover exec startup")
			}
		})
	}
}

func TestExecTimeoutDoesNotDisconnectInteractiveSSH(t *testing.T) {
	m, ref := connected(t)
	result, err := m.Run(context.Background(), ref, "sleep 2", "/tmp", 30*time.Millisecond)
	if err != nil || result.Reason != "timed_out" {
		t.Fatalf("expected command timeout: %+v, %v", result, err)
	}
	if !m.Valid(ref) {
		t.Fatal("timed-out AI command disconnected the SSH transport")
	}
	followup, err := m.Run(context.Background(), ref, "printf alive", "/tmp", normalExecTestTimeout)
	if err != nil || followup.Status != "completed" || followup.Stdout != "alive" {
		t.Fatalf("SSH must remain usable after command timeout: %+v, %v", followup, err)
	}
}

// Repeated short SSH commands must remain correct when the runner is busy.
// In particular, process startup latency must not be mistaken for a command
// timeout; cancellation semantics are covered by the dedicated 30ms tests.
func TestExecRepeatedCommandRoundTrips(t *testing.T) {
	m, ref := connected(t)
	for i := 0; i < 5; i++ {
		command := "printf 'ready'; printf 'warning' >&2; exit 3"
		result, err := m.Run(context.Background(), ref, command, "/tmp", normalExecTestTimeout)
		if err != nil || result.Status != "failed" || result.ExitCode == nil || *result.ExitCode != 3 || result.Stdout != "ready" || result.Stderr != "warning" {
			t.Fatalf("round trip %d: result=%+v err=%v", i+1, result, err)
		}
		if !m.Valid(ref) {
			t.Fatalf("round trip %d disconnected the interactive transport", i+1)
		}
	}
}
