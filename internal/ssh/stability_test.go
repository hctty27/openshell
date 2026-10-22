package sshclient

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hctty27/openshell/internal/domain"
	"github.com/hctty27/openshell/internal/testssh"
)

func TestFailedConnectionDoesNotRetainPendingAttempt(t *testing.T) {
	server := testssh.Start(t)
	trusted := keys{}
	manager := NewManager(trusted, nil)
	defer manager.Close()
	session := domain.Session{ID: "server", Host: server.Host, Port: server.Port, Username: "root", AuthType: "password"}

	_, err := manager.Connect(context.Background(), "tab", session, AuthInput{Password: "test-password"})
	var challenge *HostKeyError
	if !errors.As(err, &challenge) {
		t.Fatalf("expected first-use host key challenge, got %v", err)
	}
	assertNoPendingConnection(t, manager, "tab")

	if err := trusted.Trust(challenge.Address, challenge.Key); err != nil {
		t.Fatal(err)
	}
	_, err = manager.Connect(context.Background(), "tab", session, AuthInput{Password: "incorrect"})
	if err == nil {
		t.Fatal("invalid password unexpectedly accepted")
	}
	assertNoPendingConnection(t, manager, "tab")

	ref, err := manager.Connect(context.Background(), "tab", session, AuthInput{Password: "test-password"})
	if err != nil {
		t.Fatal(err)
	}
	if !manager.Valid(ref) {
		t.Fatal("successful connection not retained")
	}
	assertNoPendingConnection(t, manager, "tab")
}

func assertNoPendingConnection(t *testing.T, manager *Manager, tab string) {
	t.Helper()
	manager.mu.Lock()
	_, pending := manager.connecting[tab]
	manager.mu.Unlock()
	if pending {
		t.Fatalf("tab %q retained a completed connection attempt", tab)
	}
}

func TestSupersededConnectDoesNotClearNewPendingAttempt(t *testing.T) {
	// Accept TCP sockets without answering the SSH handshake to make the
	// cancellation/replacement order deterministic.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 2)
	go func() {
		for i := 0; i < 2; i++ {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			accepted <- conn
		}
	}()

	address := listener.Addr().(*net.TCPAddr)
	session := domain.Session{ID: "server", Host: "127.0.0.1", Port: address.Port, Username: "root", AuthType: "password"}
	manager := NewManager(keys{}, nil)
	defer manager.Close()

	first := make(chan error, 1)
	second := make(chan error, 1)
	go func() {
		_, err := manager.Connect(context.Background(), "tab", session, AuthInput{Password: "test-password"})
		first <- err
	}()
	waitForAcceptedConnection(t, accepted)

	go func() {
		_, err := manager.Connect(context.Background(), "tab", session, AuthInput{Password: "test-password"})
		second <- err
	}()
	waitForAcceptedConnection(t, accepted)

	select {
	case <-first:
	case <-time.After(3 * time.Second):
		t.Fatal("superseded handshake was not cancelled")
	}

	manager.mu.Lock()
	_, pending := manager.connecting["tab"]
	manager.mu.Unlock()
	if !pending {
		t.Fatal("old handshake cleared the new connection attempt")
	}

	manager.CancelTab("tab")
	select {
	case <-second:
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled handshake did not terminate")
	}
	assertNoPendingConnection(t, manager, "tab")
}

func waitForAcceptedConnection(t *testing.T, accepted <-chan net.Conn) {
	t.Helper()
	select {
	case conn := <-accepted:
		t.Cleanup(func() { _ = conn.Close() })
	case <-time.After(3 * time.Second):
		t.Fatal("SSH handshake did not reach the TCP listener")
	}
}

func TestDisconnectOnlyAffectsSelectedTab(t *testing.T) {
	server := testssh.Start(t)
	trusted := keys{}
	manager := NewManager(trusted, nil)
	defer manager.Close()
	session := domain.Session{ID: "server", Host: server.Host, Port: server.Port, Username: "root", AuthType: "password"}
	_, err := manager.Connect(context.Background(), "first", session, AuthInput{Password: "test-password"})
	var challenge *HostKeyError
	if !errors.As(err, &challenge) {
		t.Fatalf("expected first-use challenge, got %v", err)
	}
	if err := trusted.Trust(challenge.Address, challenge.Key); err != nil {
		t.Fatal(err)
	}

	first, err := manager.Connect(context.Background(), "first", session, AuthInput{Password: "test-password"})
	if err != nil { t.Fatal(err) }
	second, err := manager.Connect(context.Background(), "second", session, AuthInput{Password: "test-password"})
	if err != nil { t.Fatal(err) }
	third, err := manager.Connect(context.Background(), "third", session, AuthInput{Password: "test-password"})
	if err != nil { t.Fatal(err) }

	if err := manager.Disconnect(first); err != nil { t.Fatal(err) }
	if manager.Valid(first) { t.Fatal("disconnected tab remained valid") }
	for _, ref := range []domain.ConnectionRef{second, third} {
		sshSession, err := manager.OpenSession(ref)
		if err != nil { t.Fatalf("another tab was disconnected: %v", err) }
		_ = sshSession.Close()
	}

	reconnected, err := manager.Connect(context.Background(), "first", session, AuthInput{Password: "test-password"})
	if err != nil { t.Fatal(err) }
	if reconnected.Generation <= first.Generation { t.Fatal("reconnect reused a stale generation") }
	if manager.Valid(first) || !manager.Valid(reconnected) { t.Fatal("stale generation was accepted") }
	if err := manager.Disconnect(first); err != nil { t.Fatal(err) }
	if !manager.Valid(reconnected) { t.Fatal("stale disconnect killed a new connection") }
}

func TestTerminalWriterConcurrentHighVolumeOutput(t *testing.T) {
	events := make(chan string, 1024)
	writer := newTestTerminalWriter(events)
	const writers = 8
	const writes = 150
	var wg sync.WaitGroup
	wg.Add(writers)
	for id := 0; id < writers; id++ {
		go func(id int) {
			defer wg.Done()
			for seq := 0; seq < writes; seq++ {
				payload := fmt.Sprintf("%d:%d|", id, seq)
				if _, err := writer.Write([]byte(payload)); err != nil {
					t.Errorf("writer %d: %v", id, err)
					return
				}
			}
		}(id)
	}
	wg.Wait()
	writer.Close()

	var output strings.Builder
	for len(events) > 0 {
		output.WriteString(decodeTerminalEvent(t, <-events))
	}
	parts := strings.Split(strings.TrimSuffix(output.String(), "|"), "|")
	if len(parts) != writers*writes {
		t.Fatalf("output count %d, want %d", len(parts), writers*writes)
	}
	seen := make(map[string]bool, writers*writes)
	for _, part := range parts {
		if seen[part] {
			t.Fatalf("duplicate terminal write: %s", part)
		}
		seen[part] = true
	}
	for id := 0; id < writers; id++ {
		for seq := 0; seq < writes; seq++ {
			if !seen[strconv.Itoa(id)+":"+strconv.Itoa(seq)] {
				t.Fatalf("missing terminal output %d:%d", id, seq)
			}
		}
	}
}
