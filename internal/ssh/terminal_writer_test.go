package sshclient

import (
	"encoding/base64"
	"context"
	"github.com/hctty27/openshell/internal/domain"
	"github.com/hctty27/openshell/internal/testssh"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func newTestTerminalWriter(events chan<- string) *terminalWriter {
	manager := NewManager(nil, func(name string, payload any) {
		if name == "ssh:output" {
			events <- payload.(map[string]any)["data"].(string)
		}
	})
	return &terminalWriter{
		m: manager,
		c: &connection{history: NewHistory(1024 * 1024)},
	}
}

func decodeTerminalEvent(t *testing.T, encoded string) string {
	t.Helper()
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	return string(decoded)
}

func TestTerminalWriterCoalescesSmallChunks(t *testing.T) {
	events := make(chan string, 4)
	writer := newTestTerminalWriter(events)
	if _, err := writer.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte(" world")); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	select {
	case got := <-events:
		if text := decodeTerminalEvent(t, got); text != "hello world" {
			t.Fatalf("unexpected output %q", text)
		}
	default:
		t.Fatal("pending output not flushed on close")
	}
	select {
	case <-events:
		t.Fatal("unexpected second output event")
	default:
	}
	if _, err := writer.Write([]byte("late")); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("expected closed pipe, got %v", err)
	}
}

func TestTerminalWriterSplitsLargeOutputInOrder(t *testing.T) {
	events := make(chan string, 8)
	writer := newTestTerminalWriter(events)
	input := strings.Repeat("a", terminalOutputChunkSize*2+17)
	if _, err := writer.Write([]byte(input)); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	var output strings.Builder
	for len(events) > 0 {
		output.WriteString(decodeTerminalEvent(t, <-events))
	}
	if output.String() != input {
		t.Fatal("chunks were lost or reordered")
	}
	if writer.c.sequence != 3 {
		t.Fatalf("expected 3 output events, got %d", writer.c.sequence)
	}
}

func TestTerminalWriterFlushesWithoutClose(t *testing.T) {
	events := make(chan string, 2)
	writer := newTestTerminalWriter(events)
	defer writer.Close()
	writer.Write([]byte("prompt"))
	select {
	case encoded := <-events:
		if got := decodeTerminalEvent(t, encoded); got != "prompt" {
			t.Fatalf("unexpected output %q", got)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("small output was not flushed promptly")
	}
}

func TestNativeOnlyTerminalPreservesOrdinarySSHOutput(t *testing.T) {
	srv := testssh.Start(t)
	known := keys{}
	output := make(chan string, 16)
	manager := NewManager(known, func(name string, payload any) {
		if name != "ssh:output" { return }
		m := payload.(map[string]any)
		bytes, err := base64.StdEncoding.DecodeString(m["data"].(string))
		if err == nil { output <- string(bytes) }
	})
	defer manager.Close()
	session := domain.Session{ID: "session", Host: srv.Host, Port: srv.Port, Username: "root", AuthType: "password"}
	_, err := manager.Connect(context.Background(), "tab", session, AuthInput{Password: "test-password"})
	var challenge *HostKeyError
	if !errors.As(err, &challenge) { t.Fatalf("expected trust challenge, got %v", err) }
	if err := known.Trust(challenge.Address, challenge.Key); err != nil { t.Fatal(err) }
	ref, err := manager.Connect(context.Background(), "tab", session, AuthInput{Password: "test-password"})
	if err != nil { t.Fatal(err) }
	if err := manager.OpenTerminal(ref, 80, 24); err != nil { t.Fatal(err) }
	if err := manager.Write(ref, base64.StdEncoding.EncodeToString([]byte("plain terminal output\\n"))); err != nil { t.Fatal(err) }
	deadline := time.After(3 * time.Second)
	var got string
	for !strings.Contains(got, "plain terminal output") {
		select {
		case chunk := <-output:
			got += chunk
		case <-deadline:
			t.Fatalf("terminal output timed out: %q", got)
		}
	}
	if history := manager.History(ref); !strings.Contains(history, "plain terminal output") {
		t.Fatalf("terminal history missing plain output: %q", history)
	}
}

func TestTerminalWriterBackpressureWaitsForRenderAcknowledgement(t *testing.T) {
	events := make(chan uint64, 32)
	ref := domain.ConnectionRef{TabID: "tab", SessionID: "session", Generation: 1}
	m := NewManager(nil, func(name string, payload any) {
		if name == "ssh:output" {
			events <- payload.(map[string]any)["sequence"].(uint64)
		}
	})
	c := &connection{ref: ref, history: NewHistory(1024 * 1024)}
	writer := &terminalWriter{m: m, c: c}
	c.writer = writer
	m.connections[ref.TabID] = c
	done := make(chan error, 1)
	go func() {
		_, err := writer.Write([]byte(strings.Repeat("x", terminalOutputWindowBytes+terminalOutputChunkSize)))
		done <- err
	}()
	for i := 1; i <= terminalOutputWindowBytes/terminalOutputChunkSize; i++ {
		select {
		case sequence := <-events:
			if sequence != uint64(i) { t.Fatalf("sequence %d, expected %d", sequence, i) }
		case <-time.After(2 * time.Second):
			t.Fatal("output did not reach high watermark")
		}
	}
	select {
	case err := <-done:
		t.Fatalf("writer completed without acknowledgement: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	stale := ref
	stale.Generation++
	m.AcknowledgeOutput(stale, 1)
	select {
	case err := <-done:
		t.Fatalf("stale acknowledgement released writer: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	m.AcknowledgeOutput(ref, 1)
	select {
	case err := <-done:
		if err != nil { t.Fatal(err) }
	case <-time.After(2 * time.Second):
		t.Fatal("writer did not resume after acknowledgement")
	}
	select {
	case sequence := <-events:
		if sequence != uint64(terminalOutputWindowBytes/terminalOutputChunkSize+1) {
			t.Fatalf("wrong resumed sequence %d", sequence)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("resumed chunk was not emitted")
	}
	writer.Close()
}

func TestTerminalWriterCloseReleasesBlockedOutput(t *testing.T) {
	events := make(chan struct{}, 32)
	writer := &terminalWriter{
		m: NewManager(nil, func(name string, _ any) {
			if name == "ssh:output" { events <- struct{}{} }
		}),
		c: &connection{history: NewHistory(1024 * 1024)},
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = writer.Write([]byte(strings.Repeat("x", terminalOutputWindowBytes+terminalOutputChunkSize)))
	}()
	for i := 0; i < terminalOutputWindowBytes/terminalOutputChunkSize; i++ {
		select {
		case <-events:
		case <-time.After(2 * time.Second): t.Fatal("window was not filled")
		}
	}
	writer.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second): t.Fatal("close left writer blocked")
	}
}


