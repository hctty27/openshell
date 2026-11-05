package sshclient

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/hctty27/openshell/internal/domain"
)

func awaitNativeTerminalLease(t *testing.T, m *Manager, ref domain.ConnectionRef) *connection {
	t.Helper()
	deadline := time.After(4 * time.Second)
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		m.mu.Lock()
		c := m.connections[ref.TabID]
		valid := c != nil && c.ref == ref && c.nativeTerminalTransfer != nil
		m.mu.Unlock()
		if valid {
			c.inputGate.mu.Lock()
			leased := c.inputGate.leased
			c.inputGate.mu.Unlock()
			if leased { return c }
		}
		select {
		case <-deadline:
			t.Fatal("native transfer never acquired terminal input lease")
		case <-tick.C:
		}
	}
}

func TestNativeZmodemTerminalLifecycleCancelAndDisconnect(t *testing.T) {
	for _, variant := range []string{"cancel", "close-tab", "disconnect", "shutdown", "keepalive", "terminal-ended", "reconnect"} {
		t.Run(variant, func(t *testing.T) {
			m, ref := connected(t)
			if err := m.OpenTerminal(ref, 80, 24); err != nil { t.Fatal(err) }
			nativeTerminalSidecarTestEnv(t, "sleep")
			source := filepath.Join(t.TempDir(), "input.bin")
			if err := os.WriteFile(source, []byte("payload"), 0600); err != nil { t.Fatal(err) }
			done := make(chan error, 1)
			go func() {
				done <- m.runNativeTerminalExperiment(context.Background(), ref, os.Args[0], "upload", source, "")
			}()
			c := awaitNativeTerminalLease(t, m, ref)

			old := domain.ConnectionRef{
				TabID: ref.TabID, SessionID: ref.SessionID, Generation: ref.Generation + 1,
			}
			if m.CancelExperimentalNativeTerminalTransfer(old) {
				t.Fatal("stale generation canceled native terminal transfer")
			}
			switch variant {
			case "cancel":
				if !m.CancelExperimentalNativeTerminalTransfer(ref) {
					t.Fatal("active transfer could not be cancelled")
				}
			case "close-tab":
				m.CancelTab(ref.TabID)
			case "disconnect":
				if err := m.Disconnect(ref); err != nil { t.Fatal(err) }
			case "shutdown":
				m.Close()
			case "keepalive":
				m.failKeepalive(c, context.Background(), "keepalive_timeout")
			case "terminal-ended":
				_ = c.terminal.Close()
			case "reconnect":
				newRef, err := m.Connect(context.Background(), ref.TabID, c.session, AuthInput{Password: "test-password"})
				if err != nil { t.Fatal(err) }
				if newRef.Generation <= ref.Generation { t.Fatal("stale generation was retained") }
				if m.CancelExperimentalNativeTerminalTransfer(ref) {
					t.Fatal("stale reference canceled replacement connection")
				}
			}

			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("lifecycle %s did not cancel transfer: %v", variant, err)
				}
			case <-time.After(5 * time.Second):
				t.Fatalf("native terminal sidecar did not stop after %s", variant)
			}
			m.mu.Lock()
			left := c.nativeTerminalTransfer
			m.mu.Unlock()
			if left != nil { t.Fatal("native terminal task leaked after shutdown") }
		})
	}
}

func TestNativeZmodemTerminalLifecycleBlocksAIAndParallelTransfers(t *testing.T) {
	m, ref := connected(t)
	if err := m.OpenTerminal(ref, 80, 24); err != nil { t.Fatal(err) }
	nativeTerminalSidecarTestEnv(t, "sleep")
	source := filepath.Join(t.TempDir(), "input.bin")
	if err := os.WriteFile(source, []byte("payload"), 0600); err != nil { t.Fatal(err) }
	done := make(chan error, 1)
	go func() { done <- m.runNativeTerminalExperiment(context.Background(), ref, os.Args[0], "upload", source, "") }()
	_ = awaitNativeTerminalLease(t, m, ref)
	if _, err := m.AcquireAITerminal(ref); err == nil {
		t.Fatal("AI was allowed to share the native protocol input stream")
	}
	if err := m.runNativeTerminalExperiment(context.Background(), ref, os.Args[0], "upload", source, ""); err == nil {
		t.Fatal("second native transfer acquired the same terminal")
	}
	if !m.CancelExperimentalNativeTerminalTransfer(ref) { t.Fatal("cancel rejected active transfer") }
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) { t.Fatalf("unexpected cancel result: %v", err) }
	case <-time.After(5 * time.Second): t.Fatal("cancel did not finish")
	}
}
