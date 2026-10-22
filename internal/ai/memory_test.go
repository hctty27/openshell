package ai

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/hctty27/openshell/internal/domain"
	"strings"
	"testing"
	"time"
)

func memoryTurns(n int) []domain.ConversationMessage {
	out := []domain.ConversationMessage{}
	for i := 0; i < n; i++ {
		out = append(out, domain.ConversationMessage{Role: "user", Content: "question", Seq: int64(2*i + 1)}, domain.ConversationMessage{Role: "assistant", Content: "answer", Seq: int64(2*i + 2)})
	}
	return append(out, domain.ConversationMessage{Role: "user", Content: "current", Seq: int64(2*n + 1)})
}
func jsonSize(messages []Message) (int, error) { b, e := json.Marshal(messages); return len(b), e }
func TestContextDefaultPolicy(t *testing.T) {
	p := DefaultContextPolicy()
	if p.MaxRequestBytes != 48*1024 || p.SummaryBytes != 8*1024 || p.SummaryInputBytes != 32*1024 || p.KeepTurns != 6 || p.TriggerTurns != 20 || p.SummaryTimeout != 30*time.Second {
		t.Fatal(p)
	}
}
func TestSummaryTriggersAfter20CompleteTurns(t *testing.T) {
	calls := 0
	r, e := BuildContext(context.Background(), Message{Role: "system", Content: "system"}, memoryTurns(21), "", 0, DefaultContextPolicy(), func(context.Context, []Message) (string, error) { calls++; return "old facts", nil }, jsonSize)
	if e != nil || calls == 0 || r.Summary != "old facts" || r.ThroughSeq != 30 || r.Messages[len(r.Messages)-1].Content != "current" {
		t.Fatal(r, calls, e)
	}
}
func TestSummaryFailureRetainsRawHistory(t *testing.T) {
	h := memoryTurns(21)
	r, e := BuildContext(context.Background(), Message{Role: "system"}, h, "previous", 0, DefaultContextPolicy(), func(context.Context, []Message) (string, error) { return "", errors.New("offline") }, jsonSize)
	if e != nil || r.Summary != "previous" || r.ThroughSeq != 0 || r.Status != "recent" || len(h) != 43 {
		t.Fatal(r, e)
	}
}
func TestSummaryCancelledSkipsMainRequest(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	_, e := BuildContext(ctx, Message{Role: "system"}, memoryTurns(21), "", 0, DefaultContextPolicy(), func(context.Context, []Message) (string, error) { cancel(); return "", ctx.Err() }, jsonSize)
	if !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
}
func TestOversizedCurrentTurnReturnsError(t *testing.T) {
	_, e := BuildContext(context.Background(), Message{Role: "system"}, []domain.ConversationMessage{{Role: "user", Content: strings.Repeat("x", 49*1024)}}, "", 0, DefaultContextPolicy(), nil, jsonSize)
	if e == nil {
		t.Fatal("oversized current turn accepted")
	}
}
func TestKeepToolChainAtomic(t *testing.T) {
	calls, _ := json.Marshal([]ToolCall{{ID: "tool", Type: "function", Function: Function{Name: "propose_command", Arguments: `{"command":"pwd"}`}}})
	h := memoryTurns(10)
	h = append(h, domain.ConversationMessage{Role: "assistant", ToolCallsJSON: calls, Seq: 22}, domain.ConversationMessage{Role: "tool", ToolCallID: "tool", Content: strings.Repeat("log", 2000), Seq: 23})
	p := DefaultContextPolicy()
	p.MaxRequestBytes = 8 * 1024
	r, e := BuildContext(context.Background(), Message{Role: "system"}, h, "", 0, p, nil, jsonSize)
	if e != nil {
		t.Fatal(e)
	}
	last := r.Messages[len(r.Messages)-1]
	if last.Role != "tool" || last.ToolCallID != "tool" {
		t.Fatal(r)
	}
	found := false
	for _, m := range r.Messages {
		if len(m.ToolCalls) > 0 && m.ToolCalls[0].ID == "tool" {
			found = true
		}
	}
	if !found {
		t.Fatal("orphan tool")
	}
}
func TestBudgetIncludesJSONEscapingAndTools(t *testing.T) {
	p := NewProvider()
	profile := domain.APIProfile{Model: "model", ToolsEnabled: true}
	policy := DefaultContextPolicy()
	h := memoryTurns(18)
	for i := range h {
		if h[i].Role == "assistant" {
			h[i].Content = strings.Repeat("<\"山>\n", 1000)
		}
	}
	r, e := BuildContext(context.Background(), Message{Role: "system"}, h, "", 0, policy, nil, func(m []Message) (int, error) { return p.RequestSize(profile, m) })
	if e != nil {
		t.Fatal(e)
	}
	size, e := p.RequestSize(profile, r.Messages)
	if e != nil || size > policy.MaxRequestBytes {
		t.Fatal(size, e)
	}
}
