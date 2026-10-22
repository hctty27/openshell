package ai

import (
	"encoding/json"
	"github.com/hctty27/openshell/internal/domain"
)

func redactJSON(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	var clean func(any) any
	clean = func(v any) any {
		switch x := v.(type) {
		case string:
			return Redact(x)
		case []any:
			for i, v := range x {
				x[i] = clean(v)
			}
		case map[string]any:
			for k, v := range x {
				x[k] = clean(v)
			}
		}
		return v
	}
	return json.Marshal(clean(value))
}
func SanitizeMessage(m domain.ConversationMessage) (domain.ConversationMessage, error) {
	if m.Role == "tool" && json.Valid([]byte(m.Content)) {
		raw, err := redactJSON(json.RawMessage(m.Content))
		if err != nil {
			return m, err
		}
		m.Content = string(raw)
	} else {
		m.Content = Redact(m.Content)
	}
	if len(m.ToolCallsJSON) > 0 {
		var calls []ToolCall
		if err := json.Unmarshal(m.ToolCallsJSON, &calls); err != nil {
			return m, err
		}
		for i := range calls {
			raw, err := redactJSON(json.RawMessage(calls[i].Function.Arguments))
			if err != nil {
				return m, err
			}
			calls[i].Function.Arguments = string(raw)
		}
		raw, err := json.Marshal(calls)
		if err != nil {
			return m, err
		}
		m.ToolCallsJSON = raw
	}
	var err error
	m.DisplayJSON, err = redactJSON(m.DisplayJSON)
	return m, err
}
func ReplayHistory(history []domain.ConversationMessage) ([]Message, error) {
	result := []Message{}
	pending := []string{}
	flush := func() {
		for _, id := range pending {
			result = append(result, Message{Role: "tool", ToolCallID: id, Content: "Historical execution result is unknown or the proposal was never executed. Do not automatically retry; inspect the current server state and request new authorization."})
		}
		pending = nil
	}
	for _, m := range history {
		if m.Status == "incomplete" || m.Status == "streaming" {
			continue
		}
		if m.Role != "tool" {
			flush()
		}
		switch m.Role {
		case "user":
			result = append(result, Message{Role: "user", Content: m.Content})
		case "assistant":
			var calls []ToolCall
			if len(m.ToolCallsJSON) > 0 {
				if err := json.Unmarshal(m.ToolCallsJSON, &calls); err != nil {
					return nil, err
				}
			}
			result = append(result, Message{Role: "assistant", Content: m.Content, ToolCalls: calls})
			for _, call := range calls {
				pending = append(pending, call.ID)
			}
		case "tool":
			found := -1
			for i, id := range pending {
				if id == m.ToolCallID {
					found = i
					break
				}
			}
			if found < 0 {
				continue
			}
			result = append(result, Message{Role: "tool", Content: m.Content, ToolCallID: m.ToolCallID})
			pending = append(pending[:found], pending[found+1:]...)
		}
	}
	flush()
	return result, nil
}
