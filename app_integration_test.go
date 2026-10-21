package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/hctty27/openshell/internal/domain"
	"github.com/hctty27/openshell/internal/testssh"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTwoServersEndToEnd(t *testing.T) {
	a, e := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer a.shutdown(context.Background())
	one, two := testssh.Start(t), testssh.Start(t)
	connect := func(server *testssh.Server, tab string) domain.ConnectionRef {
		row, e := a.SaveSession(SaveSessionRequest{Session: domain.Session{Host: server.Host, Port: server.Port, Username: "root", AuthType: "password"}, Secret: "test-password", SaveSecret: true})
		if e != nil {
			t.Fatal(e)
		}
		r, e := a.Connect(tab, row.ID, "")
		if e != nil || r.Challenge == nil {
			t.Fatal(r, e)
		}
		if e = a.TrustHost(r.Challenge.ID); e != nil {
			t.Fatal(e)
		}
		r, e = a.Connect(tab, row.ID, "")
		if e != nil {
			t.Fatal(e)
		}
		return r.Ref
	}
	refA := connect(one, "a")
	refB := connect(two, "b")
	_ = refB
	countA, countB := one.Count(), two.Count()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		chunk := map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "call-a", "type": "function", "function": map[string]string{"name": "propose_command", "arguments": `{"command":"printf FIRST","purpose":"检查目标隔离","cwd":"/tmp"}`}}}}, "finish_reason": "tool_calls"}}}
		b, _ := json.Marshal(chunk)
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", b)
	}))
	defer server.Close()
	p, e := a.SaveAPI(SaveAPIRequest{Profile: domain.APIProfile{Name: "test", BaseURL: server.URL, Model: "test-model", ToolsEnabled: true}, Key: "test-key", MemoryOnly: true})
	if e != nil {
		t.Fatal(e)
	}
	reply, e := a.Chat(ChatRequest{Ref: refA, ProfileID: p.ID, Text: "检查", Operate: true})
	if e != nil || reply.Proposal == nil {
		t.Fatal(reply, e)
	}
	if one.Count() != countA || two.Count() != countB {
		t.Fatal("executed before confirmation")
	}
	result, e := a.ConfirmCommand(reply.Proposal.ID)
	if e != nil || result.Stdout != "FIRST" || result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatal(result, e)
	}
	if one.Count() != countA+1 || two.Count() != countB {
		t.Fatal("wrong target")
	}
	if _, e = a.ConfirmCommand(reply.Proposal.ID); e == nil {
		t.Fatal("duplicate confirmation accepted")
	}
	messages := a.conversations.Messages("a")
	last := messages[len(messages)-1]
	if last.Role != "tool" || last.ToolCallID != "call-a" || !strings.Contains(last.Content, "FIRST") {
		t.Fatal(last)
	}
}
func TestDeleteActiveSession(t *testing.T) {
	a, _ := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	defer a.shutdown(context.Background())
	row, _ := a.SaveSession(SaveSessionRequest{Session: domain.Session{Host: "localhost", Port: 22, Username: "root"}})
	a.tabRefs["a"] = domain.ConnectionRef{TabID: "a", SessionID: row.ID}
	if e := a.DeleteSession(row.ID); e == nil {
		t.Fatal("active session deleted")
	}
}
func TestCloseDuringConnect(t *testing.T) {
	a, _ := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	defer a.shutdown(context.Background())
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	go func() {
		c, e := ln.Accept()
		if e == nil {
			defer c.Close()
			time.Sleep(2 * time.Second)
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	row, _ := a.SaveSession(SaveSessionRequest{Session: domain.Session{Host: "127.0.0.1", Port: addr.Port, Username: "root"}})
	done := make(chan struct{})
	go func() { a.Connect("tab", row.ID, "x"); close(done) }()
	time.Sleep(30 * time.Millisecond)
	a.CloseTab("tab")
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("closing tab did not cancel pending handshake")
	}
	a.mu.Lock()
	_, exists := a.tabRefs["tab"]
	a.mu.Unlock()
	if exists {
		t.Fatal("closed tab resurrected")
	}
}
func TestCommittedCredentialWinsAfterCleanupFailure(t *testing.T) {
	v := &vault{m: map[string]string{}}
	a, _ := newApp(filepath.Join(t.TempDir(), "state.db"), v, nil)
	defer a.shutdown(context.Background())
	server := testssh.Start(t)
	row, e := a.SaveSession(SaveSessionRequest{Session: domain.Session{Host: server.Host, Port: server.Port, Username: "root", AuthType: "password"}, Secret: "wrong-password", SaveSecret: true})
	if e != nil {
		t.Fatal(e)
	}
	v.failDelete = true
	if _, e = a.SaveSession(SaveSessionRequest{Session: row, Secret: "test-password", SaveSecret: true}); e == nil {
		t.Fatal("cleanup failure not surfaced")
	}
	r, e := a.Connect("tab", row.ID, "")
	if e != nil || r.Challenge == nil {
		t.Fatal(r, e)
	}
	a.TrustHost(r.Challenge.ID)
	if _, e = a.Connect("tab", row.ID, ""); e != nil {
		t.Fatal("stale cached password overrode committed credential", e)
	}
}
