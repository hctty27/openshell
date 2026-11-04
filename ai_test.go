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
		fmt.Fprintln(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"ssh_exec","arguments":"{\"tab_id\":\""}}]}}]}`)
		fmt.Fprintln(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"a\",\"command\":\"uptime\",\"needs_confirmation\":false}"}}]}}]}`)
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

func TestAIHistoryContextNeverReplaysHistoricalTools(t *testing.T) {
	oldTab := "obsolete-tab-1234"
	messages := []store.AIMessage{
		{Role: "user", Content: "检查 Docker"},
		{Role: "assistant", Content: "正在检查", ToolCalls: []store.AIToolCall{{
			ID: "call-old", Type: "function",
			Function: store.AIFunction{Name: "ssh_exec", Arguments: `{"tab_id":"obsolete-tab-1234","command":"docker ps"}`},
		}}},
		{Role: "tool", ToolCallID: "call-old", Content: "旧检查结果"},
	}
	history := aiHistoryContext(messages)
	if len(history) != 3 { t.Fatalf("unexpected length: %d", len(history)) }
	for _, m := range history {
		if m.Role == "tool" || len(m.ToolCalls) > 0 || m.ToolCallID != "" {
			t.Fatalf("historical tool call was replayed: %#v", m)
		}
		if strings.Contains(m.Content, oldTab) { t.Fatalf("stale tab ID leaked: %q", m.Content) }
	}
	if !strings.Contains(history[2].Content, "历史工具结果") {
		t.Fatalf("tool output lost historical labeling: %#v", history[2])
	}
}


func TestAIPromptTextUsesCurrentLanguage(t *testing.T) {
	if got := aiPromptText("en", "English", "中文"); got != "English" {
		t.Fatalf("English prompt: %q", got)
	}
	if got := aiPromptText("zh-CN", "English", "中文"); got != "中文" {
		t.Fatalf("Chinese prompt: %q", got)
	}
}

func TestAIConversationScopeLegacyAndExplicit(t *testing.T) {
	cases := []struct {
		name string
		conversation store.AIConversation
		wantScope string
		wantID string
	}{
		{"legacy-global", store.AIConversation{Execution:"independent"}, "global", ""},
		{"legacy-terminal", store.AIConversation{Execution:"terminal", TargetSessionIDs:[]string{"session-a"}}, "terminal", "session-a"},
		{"explicit-global", store.AIConversation{Scope:"global", Execution:"terminal"}, "global", ""},
		{"old-duplicate-terminal", store.AIConversation{Scope:"terminal", ScopeID:"session-a:tab-b", TargetSessionIDs:[]string{"session-a"}}, "terminal", "session-a"},
		{"unbound-terminal", store.AIConversation{Scope:"terminal", ScopeID:"session-a:tab-b"}, "terminal", "session-a:tab-b"},
		{"foreign-terminal-binding", store.AIConversation{Scope:"terminal", ScopeID:"session-a:tab-b", TargetSessionIDs:[]string{"session-z"}}, "terminal", "session-a:tab-b"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scope, id := aiConversationScope(tc.conversation)
			if scope != tc.wantScope || id != tc.wantID {
				t.Fatalf("scope=%q id=%q, want scope=%q id=%q", scope, id, tc.wantScope, tc.wantID)
			}
		})
	}
}
