package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hctty27/openshell/internal/store"
)

func TestAICompletionStreamsTextAndToolCalls(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" { t.Errorf("unexpected path: %s", r.URL.Path) }
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" { t.Errorf("authorization: %s", got) }
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintln(w, `data: {"choices":[{"delta":{"content":"准备检查。"}}]}`)
		fmt.Fprintln(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"ssh_exec","arguments":"{\\"tab_id\\":\\""}}]}}]}`)
		fmt.Fprintln(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"a\\",\\"command\\":\\"uptime\\",\\"needs_confirmation\\":false}"}}]}}]}`)
		fmt.Fprintln(w, "data: [DONE]")
	}))
	defer server.Close()

	var deltas strings.Builder
	out, err := requestAICompletion(context.Background(), server.URL+"/v1", "test-key", "custom",
		[]store.AIMessage{{Role:"user",Content:"check"}}, nil, func(s string){ deltas.WriteString(s) })
	if err != nil { t.Fatal(err) }
	if out.Content != "准备检查。" || deltas.String() != "准备检查。" { t.Fatalf("unexpected streamed content: %#v",out) }
	if len(out.ToolCalls) != 1 || out.ToolCalls[0].Function.Name != "ssh_exec" {
		t.Fatalf("unexpected tool calls: %#v",out.ToolCalls)
	}
}

func TestAICompletionHTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "invalid token", http.StatusUnauthorized)
	}))
	defer server.Close()
	_, err := requestAICompletion(context.Background(), server.URL+"/v1", "bad", "model", nil, nil, func(string){})
	if err == nil || !strings.Contains(err.Error(),"401") { t.Fatalf("want HTTP 401, got %v",err) }
}
