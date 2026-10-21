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
func TestEditingConnectedSessionKeepsLiveSshTarget(t *testing.T) {
	a, err := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.shutdown(context.Background())
	server := testssh.Start(t)
	row, err := a.SaveSession(SaveSessionRequest{
		Session: domain.Session{Name: "Original", Host: server.Host, Port: server.Port, Username: "root", AuthType: "password"},
		Secret: "test-password", SaveSecret: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := a.Connect("tab", row.ID, "")
	if err != nil || first.Challenge == nil {
		t.Fatal(first, err)
	}
	if err = a.TrustHost(first.Challenge.ID); err != nil {
		t.Fatal(err)
	}
	connected, err := a.Connect("tab", row.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	row.Name, row.Host, row.Port, row.Username = "Updated", "new.example", 2222, "deploy"
	saved, err := a.SaveSession(SaveSessionRequest{Session: row, SaveSecret: true})
	if err != nil || saved.Name != "Updated" || saved.Host != "new.example" {
		t.Fatal(saved, err)
	}
	live, err := a.ssh.ConnectedSession(connected.Ref)
	if err != nil || live.Host != server.Host || live.Port != server.Port || live.Username != "root" {
		t.Fatal("SSH target changed after saving new settings", live, err)
	}
	if !a.ssh.Valid(connected.Ref) {
		t.Fatal("saving disconnected the live SSH connection")
	}
	result, err := a.ssh.Run(context.Background(), connected.Ref, "printf CONNECTED", "/tmp", 5*time.Second)
	if err != nil || result.Stdout != "CONNECTED" {
		t.Fatal("existing SSH connection cannot execute commands after save", result, err)
	}
	stored, err := a.store.GetSession(context.Background(), row.ID)
	if err != nil || stored.Name != "Updated" || stored.Host != "new.example" || stored.Port != 2222 || stored.Username != "deploy" {
		t.Fatal("next connection settings not persisted", stored, err)
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

func TestAutomaticSSHLoopBudgetAndToolHistory(t *testing.T) {
	a, err := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.shutdown(context.Background())
	sshServer := testssh.Start(t)
	row, err := a.SaveSession(SaveSessionRequest{Session: domain.Session{Host: sshServer.Host, Port: sshServer.Port, Username: "root", AuthType: "password"}, Secret: "test-password", SaveSecret: true})
	if err != nil {
		t.Fatal(err)
	}
	connected, err := a.Connect("auto-tab", row.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	a.TrustHost(connected.Challenge.ID)
	connected, err = a.Connect("auto-tab", row.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		var request struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		json.NewDecoder(r.Body).Decode(&request)
		if requests > 1 {
			found := false
			for _, m := range request.Messages {
				if m.Role == "tool" {
					found = true
				}
			}
			if !found {
				t.Error("automatic continuation missing tool result")
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		delta := map[string]any{"content": "已完成检查"}
		if requests <= 2 {
			command := "pwd"
			if requests == 2 {
				command = "uname -s"
			}
			arguments, _ := json.Marshal(map[string]string{"command": command, "purpose": "检查", "cwd": "/tmp"})
			delta = map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": fmt.Sprintf("auto-call-%d", requests), "type": "function", "function": map[string]string{"name": "propose_command", "arguments": string(arguments)}}}}
		}
		data, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": delta, "finish_reason": "tool_calls"}}})
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", data)
	}))
	defer server.Close()
	profile, err := a.SaveAPI(SaveAPIRequest{Profile: domain.APIProfile{Name: "automatic-test", BaseURL: server.URL, Model: "test", ToolsEnabled: true}, Key: "test", MemoryOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	a.SavePreference("autoCommandLimit", "1")
	count := sshServer.Count()
	state, err := a.StartAutomatic(ChatRequest{Ref: connected.Ref, ProfileID: profile.ID, Text: "检查服务器"}, "auto-task")
	if err != nil || state.Status != "limit" || state.Steps != 1 || sshServer.Count() != count+1 {
		t.Fatal(state, err, sshServer.Count(), count)
	}
	// Settings changes during a paused task apply only to the next task.
	a.SavePreference("autoCommandLimit", "5")
	state, err = a.ResumeAutomatic("auto-task", "", true)
	if err != nil || state.Status != "completed" || state.Steps != 2 || state.Limit != 1 || sshServer.Count() != count+2 {
		t.Fatal(state, err, sshServer.Count())
	}
	if requests != 3 {
		t.Fatal("unexpected model calls", requests)
	}
}
