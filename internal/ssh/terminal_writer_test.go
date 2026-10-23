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

func TestTerminalFilterPreservesOrdinarySSHOutput(t *testing.T) {
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
			t.Fatalf("filtered terminal output timed out: %q", got)
		}
	}
	if history := manager.History(ref); !strings.Contains(history, "plain terminal output") {
		t.Fatalf("terminal history missing plain output: %q", history)
	}
}

func TestCancelZmodemOnlyWhenActive(t *testing.T) {
    m, ref := connected(t)
    if err := m.CancelZmodem(ref); err == nil {
        t.Fatal("cancel should reject a missing terminal")
    }
    if err := m.OpenTerminal(ref, 80, 24); err != nil { t.Fatal(err) }
    if err := m.CancelZmodem(ref); err == nil {
        t.Fatal("cancel should reject an idle terminal")
    }
}

func TestZmodemProgressEventExtractsApproximateMetrics(t *testing.T) {
    progress := make(chan map[string]any, 4)
    m := NewManager(nil, func(name string, payload any) {
        if name == "ssh:transfer-progress" { progress <- payload.(map[string]any) }
    })
    w := &terminalWriter{m:m, c:&connection{ref:domain.ConnectionRef{TabID:"tab"}, history:NewHistory(4096)}}
    closer := &terminalOutputCloser{writer:w, done:make(chan struct{})}
    chunks := []string{"\\r\\x1b[2KTrans", "ferred 2.3 MB, Speed 1.2 MB/s."}
    for _, piece := range chunks {
        if _, err := closer.Write([]byte(piece)); err != nil { t.Fatal(err) }
    }
    select {
    case event := <-progress:
        if event["transferred"] != "2.3 MB" || event["speed"] != "1.2 MB/s" {
            t.Fatalf("unexpected transfer event: %+v", event)
        }
    default: t.Fatal("transfer progress was not reported")
    }
    closer.Close()
}

type recordingTransferFilter struct {
    stopped bool
    deletePartial bool
}
func (f *recordingTransferFilter) Close() {}
func (f *recordingTransferFilter) SetTerminalColumns(int32) {}
func (f *recordingTransferFilter) IsTransferringFiles() bool { return true }
func (f *recordingTransferFilter) StopTransferringFiles(deletePartial bool) {
    f.stopped = true
    f.deletePartial = deletePartial
}

func TestCancelZmodemDelegatesToFilterAndPreservesFiles(t *testing.T) {
    m, ref := connected(t)
    filter := &recordingTransferFilter{}
    m.mu.Lock()
    c := m.connections[ref.TabID]
    c.filter = filter
    c.stdin = &testInputWriter{}
    c.transferring = true
    m.mu.Unlock()
    if err := m.CancelZmodem(ref); err != nil { t.Fatal(err) }
    if !filter.stopped || filter.deletePartial {
        t.Fatalf("expected cancellation without deleting partial files: %+v", filter)
    }
    stale := ref
    stale.Generation++
    if err := m.CancelZmodem(stale); err == nil {
        t.Fatal("stale connection was allowed to cancel active transfer")
    }
}

type testInputWriter struct{}
func (*testInputWriter) Write(p []byte) (int, error) { return len(p), nil }


func TestZmodemLocalExitNotifiesEvenWithoutRemoteOutput(t *testing.T) {
    for _, tc := range []struct {
        name, message string
    }{
        {"successful child", "\r\x1b[2K\x1b[1;32mSuccess!!\x1b[0m\r\n"},
        {"failed child", "\r\x1b[2Kclient exit with 1\r\n"},
    } {
        t.Run(tc.name, func(t *testing.T) {
            events := make(chan string, 4)
            m := NewManager(nil, func(name string, _ any) {
                if name == "ssh:transfer-finished" { events <- name }
            })
            writer := &terminalWriter{m:m, c:&connection{ref:domain.ConnectionRef{TabID:"tab"}, history: NewHistory(8192)}}
            closer := &terminalOutputCloser{writer:writer, done:make(chan struct{})}
            defer closer.Close()
            msg := []byte(tc.message)
            for _, chunk := range [][]byte{msg[:7], msg[7:len(msg)-2], msg[len(msg)-2:]} {
                if _, err := closer.Write(chunk); err != nil { t.Fatal(err) }
            }
            select {
            case <-events:
            default: t.Fatal("local ZMODEM exit was not reported")
            }
            if len(events) != 0 { t.Fatal("local ZMODEM exit reported more than once") }
            if _, err := closer.Write([]byte("shell prompt\r\n")); err != nil { t.Fatal(err) }
            if len(events) != 0 { t.Fatal("terminal output repeated ZMODEM exit") }
        })
    }
}

func TestZmodemLocalExitIgnoresNormalTerminalText(t *testing.T) {
    events := make(chan string, 2)
    m := NewManager(nil, func(name string, _ any) {
        if name == "ssh:transfer-finished" { events <- name }
    })
    writer := &terminalWriter{m:m, c:&connection{ref:domain.ConnectionRef{TabID:"tab"}, history:NewHistory(8192)}}
    closer := &terminalOutputCloser{writer:writer, done:make(chan struct{})}
    defer closer.Close()
    if _, err := closer.Write([]byte("Success!!\r\nclient exit with 1\r\n")); err != nil { t.Fatal(err) }
    if len(events) != 0 { t.Fatal("normal terminal text was treated as ZMODEM exit") }
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
