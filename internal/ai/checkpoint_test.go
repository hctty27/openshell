package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/hctty27/openshell/internal/domain"
)

func automaticHistory(steps int) []domain.ConversationMessage {
	history := []domain.ConversationMessage{{Role: "user", Seq: 1, Content: "Inspect the server and report failures"}}
	for i := 0; i < steps; i++ {
		id := fmt.Sprintf("call-%d", i)
		args, _ := json.Marshal(map[string]string{"command": fmt.Sprintf("tail -n 50 /var/log/app-%d.log", i), "purpose": "inspect", "cwd": "/var/log"})
		calls, _ := json.Marshal([]ToolCall{{ID: id, Type: "function", Function: Function{Name: "propose_command", Arguments: string(args)}}})
		result, _ := json.Marshal(map[string]any{"command": fmt.Sprintf("tail -n 50 /var/log/app-%d.log", i), "status": "completed", "exitCode": 0, "stdout": strings.Repeat("server output; ", 480)})
		history = append(history,
			domain.ConversationMessage{Role: "assistant", Seq: int64(2*i + 2), ToolCallsJSON: calls},
			domain.ConversationMessage{Role: "tool", Seq: int64(2*i + 3), ToolCallID: id, Content: string(result)},
		)
	}
	return history
}

func TestAutomaticToolChainCompactsWithoutLosingRecentPairs(t *testing.T) {
	history := automaticHistory(50)
	original := history[2].Content
	policy := DefaultContextPolicy()
	result, err := BuildContext(context.Background(), Message{Role: "system", Content: "server assistant"}, history, "", 0, policy, nil, jsonSize)
	if err != nil {
		t.Fatal(err)
	}
	size, err := jsonSize(result.Messages)
	if err != nil || size > policy.MaxRequestBytes {
		t.Fatalf("size=%d err=%v", size, err)
	}
	if !strings.Contains(fmt.Sprint(result.Messages), "OpenShell execution checkpoint") {
		t.Fatal("missing execution checkpoint")
	}
	if history[2].Content != original {
		t.Fatal("persisted history modified")
	}
	seen := make(map[string]bool)
	for _, m := range result.Messages {
		if len(m.ToolCalls) > 0 {
			for _, call := range m.ToolCalls {
				seen[call.ID] = true
			}
		}
		if m.Role == "tool" && !seen[m.ToolCallID] {
			t.Fatalf("orphan tool result: %s", m.ToolCallID)
		}
	}
	for _, id := range []string{"call-47", "call-48", "call-49"} {
		if !seen[id] {
			t.Fatalf("missing recent call: %s", id)
		}
	}
}

func TestCheckpointMarksUnknownAndNonzeroOutcomes(t *testing.T) {
	messages := []Message{{Role: "user", Content: "Check server"}}
	for _, spec := range []struct{ id, body string }{
		{"a", `{"status":"unknown","reason":"connection_lost"}`},
		{"b", `{"status":"completed","exitCode":7,"stderr":"permission denied"}`},
		{"c", `{"status":"completed","exitCode":0}`},
	} {
		messages = append(messages,
			Message{Role: "assistant", ToolCalls: []ToolCall{{ID: spec.id, Function: Function{Name: "propose_command", Arguments: `{"command":"pwd","cwd":"/tmp"}`}}}},
			Message{Role: "tool", ToolCallID: spec.id, Content: spec.body},
		)
	}
	compacted, ok := CompactToolHistory(messages, 1)
	if !ok {
		t.Fatal("expected checkpoint")
	}
	checkpoint := compacted[1].Content
	if !strings.Contains(checkpoint, "unknown") || !strings.Contains(checkpoint, "nonzero") {
		t.Fatalf("execution results lost: %s", checkpoint)
	}
	if len(compacted) != 4 || compacted[2].ToolCalls[0].ID != "c" || compacted[3].ToolCallID != "c" {
		t.Fatalf("latest call/result pair changed: %+v", compacted)
	}
}

func TestIncompleteToolCycleIsNeverCompacted(t *testing.T) {
	messages := []Message{
		{Role: "user", Content: "inspect"},
		{Role: "assistant", ToolCalls: []ToolCall{{ID: "pending", Function: Function{Name: "propose_command", Arguments: "{}"}}}},
	}
	compacted, ok := CompactToolHistory(messages, 0)
	if ok || len(compacted) != len(messages) {
		t.Fatal("incomplete tool cycle was compacted")
	}
}

func TestToolResultKeepsErrorAndValidUTF8(t *testing.T) {
	code := 7
	body := BuildToolResult("cat /var/log/app.log", "/var/log", domain.CommandResult{
		Status: "failed", ExitCode: &code,
		Stdout: strings.Repeat("你好 output\n", 2000),
		Stderr: "fatal: cannot read file\n" + strings.Repeat("x", 20000) + "\nlast error",
	})
	if len(body) > 8192 || !utf8.ValidString(body) {
		t.Fatalf("invalid bounded tool output: %d bytes", len(body))
	}
	var result struct {
		ExitCode *int   `json:"exitCode"`
		Status   string `json:"status"`
		Stderr   string `json:"stderr"`
		Truncated bool `json:"truncated"`
	}
	if err := json.Unmarshal([]byte(body), &result); err != nil || result.Status != "failed" || result.ExitCode == nil || *result.ExitCode != 7 || !result.Truncated || !strings.Contains(result.Stderr, "last error") || !strings.Contains(result.Stderr, "fatal:") {
		t.Fatalf("important failure context missing: %+v, %v", result, err)
	}
}
