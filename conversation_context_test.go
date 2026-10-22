package main

import (
	"fmt"
	"github.com/hctty27/openshell/internal/domain"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCancelledSummaryNeverStartsMainRequest(t *testing.T) {
	a, _, one, _, _, _ := memoryFixture(t, false)
	run, e := a.startExecution(one.Ref, "chat")
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 21; i++ {
		for _, role := range []string{"user", "assistant"} {
			if e = a.appendHistory(run.ID, domain.ConversationMessage{ID: domain.NewID(), Role: role, Content: "old facts"}); e != nil {
				t.Fatal(e)
			}
		}
	}
	a.finishExecution(run.ID)
	started := make(chan struct{}, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		started <- struct{}{}
		<-r.Context().Done()
	}))
	defer server.Close()
	p, e := a.SaveAPI(SaveAPIRequest{Profile: domain.APIProfile{BaseURL: server.URL, Model: "summary"}, MemoryOnly: true})
	if e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { _, e := a.Chat(ChatRequest{Ref: one.Ref, ProfileID: p.ID, Text: "continue"}); done <- e }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("summary not called")
	}
	if e = a.CancelChat(one.Ref); e != nil {
		t.Fatal(e)
	}
	select {
	case e := <-done:
		if e == nil {
			t.Fatal("cancellation ignored")
		}
	case <-time.After(time.Second):
		t.Fatal("summary did not cancel")
	}
	select {
	case <-started:
		t.Fatal("main request was started")
	default:
	}
	page, e := a.ReadConversation(one.Ref, one.ConversationID, 0, 100)
	if e != nil || len(page.Messages) != 43 || page.Conversation.Summary != "" {
		t.Fatal(fmt.Sprint(page), e)
	}
}
