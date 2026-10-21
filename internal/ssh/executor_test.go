package sshclient

import (
	"context"
	"errors"
	"github.com/hctty27/openshell/internal/domain"
	"github.com/hctty27/openshell/internal/testssh"
	"os"
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
func TestExecExitCode(t *testing.T) {
	m, r := connected(t)
	v, e := m.Run(context.Background(), r, "printf hello; printf error >&2; exit 7", "/tmp", time.Second)
	if e != nil || v.ExitCode == nil || *v.ExitCode != 7 || v.Stdout != "hello" || v.Stderr != "error" || v.Status != "failed" {
		t.Fatalf("%+v %v", v, e)
	}
}
func TestExecOutputCap(t *testing.T) {
	m, r := connected(t)
	v, e := m.Run(context.Background(), r, "head -c 300000 /dev/zero", "/tmp", time.Second*5)
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
	v, e := m.Run(context.Background(), r, "read value; echo done", "/tmp", time.Second)
	if e != nil || !strings.Contains(v.Stdout, "done") {
		t.Fatalf("%+v %v", v, e)
	}
}
func TestShellQuotedWorkingDirectory(t *testing.T) {
	dir := t.TempDir() + "/quote' space; echo wrong"
	if e := os.MkdirAll(dir, 0700); e != nil {
		t.Fatal(e)
	}
	m, r := connected(t)
	v, e := m.Run(context.Background(), r, "pwd", dir, time.Second)
	if e != nil || strings.TrimSpace(v.Stdout) != dir {
		t.Fatalf("%+v %v", v, e)
	}
}
func TestFailedWorkingDirectoryDoesNotRunAnyScriptCommands(t *testing.T) {
	m, r := connected(t)
	v, e := m.Run(context.Background(), r, "printf FIRST; printf UNSAFE", "/definitely-missing-openshell-directory", time.Second)
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
			case <-time.After(300 * time.Millisecond):
				t.Fatal("timeout does not cover exec startup")
			}
		})
	}
}
