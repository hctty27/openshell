package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/hctty27/openshell/internal/domain"
	"github.com/hctty27/openshell/internal/tasks"
	"github.com/hctty27/openshell/internal/testssh"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func memoryConnect(t *testing.T, a *App, row domain.Session, tab string) ConnectResult {
	t.Helper()
	r, e := a.Connect(tab, row.ID, "test-password")
	if e != nil {
		t.Fatal(e)
	}
	if r.Challenge != nil {
		if e = a.TrustHost(r.Challenge.ID); e != nil {
			t.Fatal(e)
		}
		r, e = a.Connect(tab, row.ID, "test-password")
		if e != nil {
			t.Fatal(e)
		}
	}
	return r
}
func memoryFixture(t *testing.T, tool bool) (*App, domain.Session, ConnectResult, ConnectResult, domain.APIProfile, *testssh.Server) {
	return memoryFixtureAt(t, tool, filepath.Join(t.TempDir(), "state.db"))
}
func memoryFixtureAt(t *testing.T, tool bool, path string) (*App, domain.Session, ConnectResult, ConnectResult, domain.APIProfile, *testssh.Server) {
	t.Helper()
	a, e := newApp(path, &vault{m: map[string]string{}}, nil)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { a.shutdown(context.Background()) })
	remote := testssh.Start(t)
	row, e := a.SaveSession(SaveSessionRequest{Session: domain.Session{Host: remote.Host, Port: remote.Port, Username: "root", AuthType: "password"}})
	if e != nil {
		t.Fatal(e)
	}
	one := memoryConnect(t, a, row, "a")
	two := memoryConnect(t, a, row, "b")
	if one.ConversationID != "" || two.ConversationID != "" {
		t.Fatal("initial SSH connection created unwanted history", one, two)
	}
	seed, e := a.CreateConversation(one.Ref)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = a.SelectConversation(two.Ref, seed.ID); e != nil {
		t.Fatal(e)
	}
	one.ConversationID = seed.ID
	two.ConversationID = seed.ID
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		delta := map[string]any{"content": "remembered"}
		reason := "stop"
		if tool {
			delta = map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "tool-1", "type": "function", "function": map[string]string{"name": "propose_command", "arguments": `{"command":"printf MEMORY","purpose":"check","cwd":"/tmp"}`}}}}
			reason = "tool_calls"
		}
		b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": delta, "finish_reason": reason}}})
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", b)
	}))
	t.Cleanup(server.Close)
	profile, e := a.SaveAPI(SaveAPIRequest{Profile: domain.APIProfile{BaseURL: server.URL, Model: "test", ToolsEnabled: tool}, MemoryOnly: true})
	if e != nil {
		t.Fatal(e)
	}
	return a, row, one, two, profile, remote
}
func TestSharedConversationSurvivesAppRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "restart.db")
	a, row, one, two, p, _ := memoryFixtureAt(t, false, path)
	if one.ConversationID == "" || one.ConversationID != two.ConversationID {
		t.Fatal(one, two)
	}
	if _, e := a.Chat(ChatRequest{Ref: one.Ref, ProfileID: p.ID, Text: "remember this"}); e != nil {
		t.Fatal(e)
	}
	page, e := a.ReadConversation(two.Ref, one.ConversationID, 0, 100)
	if e != nil || len(page.Messages) != 2 {
		t.Fatal(page, e)
	}
	a.CloseTab("a")
	a.CloseTab("b")
	again := memoryConnect(t, a, row, "c")
	if again.ConversationID != one.ConversationID {
		t.Fatal(again)
	}
	// A new App instance reads the same database, without relying on the previous service's cache.
	b, e := newApp(path, &vault{m: map[string]string{}}, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer b.shutdown(context.Background())
	restored := memoryConnect(t, b, row, "restart")
	page, e = b.ReadConversation(restored.Ref, restored.ConversationID, 0, 100)
	if e != nil || len(page.Messages) != 2 || page.Messages[1].Content != "remembered" {
		t.Fatal(page, e)
	}
}
func TestObserverCannotControlProposal(t *testing.T) {
	a, _, one, two, p, remote := memoryFixture(t, true)
	count := remote.Count()
	reply, e := a.Chat(ChatRequest{Ref: one.Ref, ProfileID: p.ID, Text: "check", Operate: true})
	if e != nil || reply.Proposal == nil {
		t.Fatal(reply, e)
	}
	if _, e = a.ConfirmCommand(two.Ref, reply.Proposal.ID); e == nil {
		t.Fatal("observer executed")
	}
	if e = a.CancelCommand(two.Ref, reply.Proposal.ID); e == nil {
		t.Fatal("observer cancelled")
	}
	if _, e = a.ReviseProposal(two.Ref, reply.Proposal.ID, "pwd", "/tmp", 60); e == nil {
		t.Fatal("observer edited")
	}
	if remote.Count() != count {
		t.Fatal("wrong tab executed")
	}
	result, e := a.ConfirmCommand(one.Ref, reply.Proposal.ID)
	if e != nil || result.Stdout != "MEMORY" || remote.Count() != count+1 {
		t.Fatal(result, e)
	}
}
func TestClearRejectsWhileAwaitingConfirmation(t *testing.T) {
	a, _, one, _, p, _ := memoryFixture(t, true)
	reply, e := a.Chat(ChatRequest{Ref: one.Ref, ProfileID: p.ID, Text: "check", Operate: true})
	if e != nil {
		t.Fatal(e)
	}
	if e = a.ClearChat("b"); e == nil {
		t.Fatal("shared busy conversation cleared")
	}
	if _, e = a.CreateConversation(one.Ref); e == nil {
		t.Fatal("owner switched during proposal")
	}
	if e = a.CancelCommand(one.Ref, reply.Proposal.ID); e != nil {
		t.Fatal(e)
	}
	if e = a.ClearChat("b"); e != nil {
		t.Fatal(e)
	}
}
func TestClosingOwnerStopsSharedRun(t *testing.T) {
	a, _, one, two, p, remote := memoryFixture(t, true)
	reply, e := a.Chat(ChatRequest{Ref: one.Ref, ProfileID: p.ID, Text: "check", Operate: true})
	if e != nil {
		t.Fatal(e)
	}
	count := remote.Count()
	if e = a.CloseTab("a"); e != nil {
		t.Fatal(e)
	}
	page, e := a.ReadConversation(two.Ref, two.ConversationID, 0, 100)
	if e != nil || page.Run != nil {
		t.Fatal(page, e)
	}
	if _, e = a.ConfirmCommand(two.Ref, reply.Proposal.ID); e == nil || remote.Count() != count {
		t.Fatal("old proposal ran")
	}
}
func TestEditingLiveSessionKeepsHistoryTarget(t *testing.T) {
	a, row, one, _, p, _ := memoryFixture(t, false)
	row.Host = "new.example"
	if _, e := a.SaveSession(SaveSessionRequest{Session: row}); e != nil {
		t.Fatal(e)
	}
	if _, e := a.Chat(ChatRequest{Ref: one.Ref, ProfileID: p.ID, Text: "old target"}); e != nil {
		t.Fatal(e)
	}
	page, e := a.ReadConversation(one.Ref, one.ConversationID, 0, 100)
	if e != nil || len(page.Messages) != 2 {
		t.Fatal(page, e)
	}
	if strings.Contains(page.Conversation.ServerKey, "new.example") {
		t.Fatal(page)
	}
}
func TestPersistFailurePreventsCommandExecution(t *testing.T) {
	a, _, one, _, p, remote := memoryFixture(t, true)
	count := remote.Count()
	a.store.Close()
	if _, e := a.Chat(ChatRequest{Ref: one.Ref, ProfileID: p.ID, Text: "check", Operate: true}); e == nil {
		t.Fatal("database failure hidden")
	}
	if remote.Count() != count {
		t.Fatal("executed without history")
	}
}
func TestMemorySettingsDefaultOnAndValidate(t *testing.T) {
	a, _, _, _, _, _ := memoryFixture(t, false)
	state, e := a.State()
	if e != nil || !state.SaveChatHistory || !state.AutoSummarize {
		t.Fatal(state, e)
	}
	for _, key := range []string{"saveChatHistory", "autoSummarize"} {
		if e = a.SavePreference(key, "bad"); e == nil {
			t.Fatal("invalid boolean accepted")
		}
		if e = a.SavePreference(key, "false"); e != nil {
			t.Fatal(e)
		}
	}
	state, e = a.State()
	if e != nil || state.SaveChatHistory || state.AutoSummarize {
		t.Fatal(state, e)
	}
}
func TestCannotToggleStorageWhileRunning(t *testing.T) {
	a, _, one, _, p, _ := memoryFixture(t, true)
	reply, e := a.Chat(ChatRequest{Ref: one.Ref, ProfileID: p.ID, Text: "check", Operate: true})
	if e != nil {
		t.Fatal(e)
	}
	if e = a.SavePreference("saveChatHistory", "false"); e == nil {
		t.Fatal("changed storage during pending command")
	}
	a.CancelCommand(one.Ref, reply.Proposal.ID)
	if e = a.SavePreference("saveChatHistory", "false"); e != nil {
		t.Fatal(e)
	}
}
func TestStaleAutomaticControlDoesNotStopNewChat(t *testing.T) {
	a, _, one, _, p, _ := memoryFixture(t, true)
	state, e := a.StartAutomatic(ChatRequest{Ref: one.Ref, ProfileID: p.ID, Text: "check"}, "old-task")
	if e != nil || state.Status != "awaiting_confirmation" {
		t.Fatal(state, e)
	}
	if e = a.StopAutomatic(one.Ref, "old-task"); e != nil {
		t.Fatal(e)
	}
	reply, e := a.Chat(ChatRequest{Ref: one.Ref, ProfileID: p.ID, Text: "new task", Operate: true})
	if e != nil || reply.Proposal == nil {
		t.Fatal(reply, e)
	}
	if e = a.StopAutomatic(one.Ref, "old-task"); e == nil {
		t.Fatal("stale task control accepted")
	}
	if _, e = a.memory.CurrentRun(one.Ref); e != nil {
		t.Fatal("new task was cancelled", e)
	}
}
func TestOldProposalCannotEndNewRun(t *testing.T) {
	a, _, one, _, p, _ := memoryFixture(t, true)
	first, e := a.Chat(ChatRequest{Ref: one.Ref, ProfileID: p.ID, Text: "first", Operate: true})
	if e != nil {
		t.Fatal(e)
	}
	if e = a.CancelCommand(one.Ref, first.Proposal.ID); e != nil {
		t.Fatal(e)
	}
	second, e := a.Chat(ChatRequest{Ref: one.Ref, ProfileID: p.ID, Text: "second", Operate: true})
	if e != nil || second.Proposal == nil {
		t.Fatal(second, e)
	}
	if _, e = a.ConfirmCommand(one.Ref, first.Proposal.ID); e == nil {
		t.Fatal("old proposal accepted")
	}
	if _, e = a.memory.CurrentRun(one.Ref); e != nil {
		t.Fatal("new run ended", e)
	}
}
func TestConcurrentOperationIsRejectedBeforeChangingOwnership(t *testing.T) {
	a, _, one, _, _, _ := memoryFixture(t, false)
	run, e := a.startExecution(one.Ref, "chat")
	if e != nil {
		t.Fatal(e)
	}
	_, done, e := a.operation(run)
	if e != nil {
		t.Fatal(e)
	}
	defer done()
	_, other, e := a.operation(run)
	if e == nil {
		other()
		t.Fatal("overlapping operation accepted")
	}
}
func TestDisconnectNotificationDoesNotWaitForItsOwnOperation(t *testing.T) {
	a, _, one, _, _, _ := memoryFixture(t, false)
	run, e := a.startExecution(one.Ref, "chat")
	if e != nil {
		t.Fatal(e)
	}
	_, done, e := a.operation(run)
	if e != nil {
		t.Fatal(e)
	}
	disconnected := make(chan struct{})
	go func() { a.ssh.Disconnect(one.Ref); close(disconnected) }()
	select {
	case <-disconnected:
		done()
	case <-time.After(200 * time.Millisecond):
		done()
		<-disconnected
		t.Fatal("disconnect callback waited for the operation invoking it")
	}
}
func TestCancelledLeaseCannotRegisterAutomaticTask(t *testing.T) {
	a, _, one, _, _, _ := memoryFixture(t, false)
	run, e := a.startExecutionWithTask(one.Ref, "auto", "cancelled-task")
	if e != nil {
		t.Fatal(e)
	}
	a.cancelRun(run.ID, one.Ref, false)
	if e = a.registerAutomatic(run, "cancelled-task", 10, false, tasks.AutoCallbacks{}); e == nil {
		t.Fatal("registered automatic runner after cancellation")
	}
}
func TestCancellationPreventsLateProposalRegistration(t *testing.T) {
	a, _, one, _, _, _ := memoryFixture(t, false)
	run, e := a.startExecution(one.Ref, "chat")
	if e != nil {
		t.Fatal(e)
	}
	ctx, done, e := a.operation(run)
	if e != nil {
		t.Fatal(e)
	}
	a.cancelRun(run.ID, one.Ref, false)
	if _, e = a.registerProposal(ctx, run, tasks.ToolInput{Command: "pwd", Purpose: "check", Cwd: "/tmp"}, "call"); e == nil {
		t.Error("late proposal created")
	}
	done()
	next, e := a.startExecution(one.Ref, "chat")
	if e != nil {
		t.Fatal("old cancellation blocked replacement", e)
	}
	a.cancelRun(run.ID, one.Ref, false)
	if _, e = a.memory.CurrentRun(one.Ref); e != nil {
		t.Fatal("old cleanup affected replacement", e)
	}
	a.finishExecution(next.ID)
}
func TestStaleDisconnectCannotReopenClosingConnection(t *testing.T) {
	a, _, one, _, _, _ := memoryFixture(t, false)
	a.cancelExecution(one.Ref, false)
	old := one.Ref
	old.Generation--
	a.cancelExecution(old, false)
	if _, e := a.startExecution(one.Ref, "chat"); e == nil {
		t.Fatal("stale notification removed closing barrier")
	}
}
func TestLateRevisionCannotReviveCancelledProposal(t *testing.T) {
	a, _, one, _, p, _ := memoryFixture(t, true)
	reply, e := a.Chat(ChatRequest{Ref: one.Ref, ProfileID: p.ID, Text: "check", Operate: true})
	if e != nil {
		t.Fatal(e)
	}
	run, e := a.memory.CurrentRun(one.Ref)
	if e != nil {
		t.Fatal(e)
	}
	_, done, e := a.operation(run)
	if e != nil {
		t.Fatal(e)
	}
	a.cancelRun(run.ID, one.Ref, false)
	if _, e = a.reviseOwnedProposal(run, reply.Proposal.ID, "pwd", "/tmp", 60); e == nil {
		t.Error("cancelled proposal revived")
	}
	done()
}

func TestConversationDraftPersistsOnlyAfterSending(t *testing.T) {
	a, row, first, peer, profile, _ := memoryFixture(t, false)
	list, err := a.ListConversations(first.Ref, nil, 50)
	if err != nil || len(list.Items) != 1 {
		t.Fatal(list, err)
	}
	if err = a.StartConversationDraft(first.Ref); err != nil {
		t.Fatal(err)
	}
	if err = a.StartConversationDraft(first.Ref); err != nil {
		t.Fatal(err)
	}
	list, err = a.ListConversations(first.Ref, nil, 50)
	if err != nil || len(list.Items) != 1 {
		t.Fatal("empty draft persisted", list, err)
	}
	if _, err = a.Chat(ChatRequest{Ref: first.Ref, ProfileID: profile.ID, Text: "new session"}); err != nil {
		t.Fatal(err)
	}
	list, err = a.ListConversations(first.Ref, nil, 50)
	if err != nil || len(list.Items) != 2 {
		t.Fatal("first message did not save draft", list, err)
	}
	peerSelected, err := a.memory.Selected(peer.Ref)
	if err != nil || peerSelected != peer.ConversationID {
		t.Fatal("changed peer selection", peerSelected, err)
	}
	a.CloseTab("a")
	a.CloseTab("b")
	reconnected := memoryConnect(t, a, row, "new")
	if reconnected.ConversationID == "" {
		t.Fatal("sent draft did not survive reconnect")
	}
}
