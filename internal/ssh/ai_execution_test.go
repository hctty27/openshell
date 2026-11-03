package sshclient

import (
	"context"
	"errors"
	"testing"

	"github.com/hctty27/openshell/internal/domain"
	"github.com/hctty27/openshell/internal/testssh"
)

func connectAIExecutionFixture(t *testing.T, mode string) (*Manager, domain.ConnectionRef, *testssh.Server) {
	t.Helper()
	server := testssh.StartWithMode(t, mode)
	trusted := keys{}
	manager := NewManager(trusted, nil)
	t.Cleanup(manager.Close)
	session := domain.Session{
		ID: "ai-exec", Host: server.Host, Port: server.Port,
		Username: "root", AuthType: "password",
	}
	_, err := manager.Connect(context.Background(), "tab", session, AuthInput{Password: "test-password"})
	var challenge *HostKeyError
	if !errors.As(err, &challenge) { t.Fatalf("expected host key challenge: %v", err) }
	if err := trusted.Trust(challenge.Address, challenge.Key); err != nil { t.Fatal(err) }
	ref, err := manager.Connect(context.Background(), "tab", session, AuthInput{Password: "test-password"})
	if err != nil { t.Fatal(err) }
	return manager, ref, server
}

func TestAIExecutionModePrefersIndependentAndCachesProbe(t *testing.T) {
	manager, ref, server := connectAIExecutionFixture(t, "normal")
	for i := 0; i < 2; i++ {
		mode, err := manager.AIExecutionMode(context.Background(), ref)
		if err != nil || mode != "independent" {
			t.Fatalf("iteration %d: mode=%q err=%v", i, mode, err)
		}
	}
	if count := server.Count(); count != 1 {
		t.Fatalf("expected a single harmless exec probe, got %d", count)
	}
}

func TestAIExecutionModeFallsBackBeforeUserCommand(t *testing.T) {
	manager, ref, _ := connectAIExecutionFixture(t, "noexec")
	mode, err := manager.AIExecutionMode(context.Background(), ref)
	if err != nil || mode != "terminal" {
		t.Fatalf("expected terminal fallback, mode=%q err=%v", mode, err)
	}
}

func TestAIExecutionModeNeverProbesKnownJumpServer(t *testing.T) {
	manager := NewManager(nil, nil)
	ref := domain.ConnectionRef{TabID: "jump", SessionID: "jump-session", Generation: 2}
	manager.connections[ref.TabID] = &connection{
		ref: ref, serverVersion: "SSH-2.0-JumpServer",
	}
	mode, err := manager.AIExecutionMode(context.Background(), ref)
	if err != nil || mode != "terminal" {
		t.Fatalf("expected JumpServer to use the visible terminal, got %q / %v", mode, err)
	}
	if manager.connections[ref.TabID].aiExecProbed {
		t.Fatal("known JumpServer must not receive an independent exec probe")
	}
}

func TestAIExecutionModeDetectsJumpServerFromTerminalOutput(t *testing.T) {
	manager := NewManager(nil, nil)
	ref := domain.ConnectionRef{TabID: "jump", SessionID: "jump-session", Generation: 1}
	c := &connection{ref: ref, serverVersion: "SSH-2.0-UnknownBastion"}
	c.readiness.observe([]byte("JumpServer 开源堡垒机\r\nOpt> "))
	manager.connections[ref.TabID] = c
	mode, err := manager.AIExecutionMode(context.Background(), ref)
	if err != nil || mode != "terminal" { t.Fatalf("mode=%q err=%v", mode, err) }
	if c.aiExecProbed { t.Fatal("bastion UI should bypass independent exec probe") }
}

func TestAIExecutionModeRejectsOldGeneration(t *testing.T) {
	manager, ref, _ := connectAIExecutionFixture(t, "normal")
	ref.Generation--
	if _, err := manager.AIExecutionMode(context.Background(), ref); err == nil {
		t.Fatal("stale SSH reference should not be executable")
	}
}
