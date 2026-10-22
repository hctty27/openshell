package ai

import (
	"encoding/json"
	"github.com/hctty27/openshell/internal/domain"
	"strings"
	"testing"
)

func TestRestorePendingToolDoesNotExecute(t *testing.T) {
	calls, _ := json.Marshal([]ToolCall{{ID: "pending", Type: "function", Function: Function{Name: "propose_command", Arguments: `{"command":"restart"}`}}})
	messages, err := ReplayHistory([]domain.ConversationMessage{{Role: "user", Content: "check"}, {Role: "assistant", ToolCallsJSON: calls}, {Role: "assistant", Content: "partial", Status: "incomplete"}})
	if err != nil || len(messages) != 3 || messages[2].Role != "tool" || messages[2].ToolCallID != "pending" || !strings.Contains(messages[2].Content, "unknown") {
		t.Fatal(messages, err)
	}
}
func TestHistoryRedactsStructuredToolArguments(t *testing.T) {
	calls, _ := json.Marshal([]ToolCall{{ID: "c", Type: "function", Function: Function{Name: "propose_command", Arguments: `{"command":"TOKEN=abc password=secret","cwd":"/tmp","purpose":"check"}`}}})
	m, err := SanitizeMessage(domain.ConversationMessage{Role: "assistant", Content: "api_key=super-secret", ToolCallsJSON: calls})
	if err != nil || strings.Contains(string(m.ToolCallsJSON), "secret") || strings.Contains(m.Content, "super-secret") {
		t.Fatal(m, err)
	}
	var restored []ToolCall
	if err = json.Unmarshal(m.ToolCallsJSON, &restored); err != nil || !json.Valid([]byte(restored[0].Function.Arguments)) {
		t.Fatal(string(m.ToolCallsJSON), err)
	}
}
func TestToolResultRemainsJSONAfterRedaction(t *testing.T) {
	content := BuildToolResult("pwd", "/tmp", domain.CommandResult{Status: "completed", Stdout: "password=secret"})
	m, e := SanitizeMessage(domain.ConversationMessage{Role: "tool", Content: content})
	if e != nil || !json.Valid([]byte(m.Content)) {
		t.Fatal("invalid result JSON", m.Content, e)
	}
}
