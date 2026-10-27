package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
)

// AnthropicAdapter maps Messages SSE events into the same reply/tool structure
// used by the existing command confirmation and history pipeline.
type AnthropicAdapter struct {
	client *http.Client
}

func NewAnthropicAdapter() *AnthropicAdapter {
	return &AnthropicAdapter{client: &http.Client{
		Timeout: 5 * time.Minute,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return apperror.New("apiRedirectBlockedEnterTheFinalEndpointDirectly", nil)
		},
	}}
}

func NormalizeAnthropicEndpoint(base string) (string, error) {
	// Reuse the existing SSRF-related URL rules without treating Messages as
	// an OpenAI Chat Completions endpoint.
	if _, err := NormalizeEndpoint(base); err != nil { return "", err }
	u, err := url.Parse(strings.TrimSpace(base))
	if err != nil { return "", err }
	u.Path = strings.TrimRight(u.Path, "/")
	switch {
	case strings.HasSuffix(u.Path, "/messages"):
	case strings.HasSuffix(u.Path, "/v1"):
		u.Path += "/messages"
	default:
		u.Path += "/v1/messages"
	}
	u.RawPath = ""
	return u.String(), nil
}

func encodeAnthropicRequest(profile domain.APIProfile, messages []Message) ([]byte, error) {
	var system []string
	type msg struct {
		Role string `json:"role"`
		Content any `json:"content"`
	}
	var result []msg
	for _, message := range messages {
		switch message.Role {
		case "system":
			if message.Content != "" { system = append(system, message.Content) }
		case "user":
			if message.Content != "" {
				result = append(result, msg{Role: "user", Content: message.Content})
			}
		case "assistant":
			var blocks []map[string]any
			if message.Content != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": message.Content})
			}
			for _, call := range message.ToolCalls {
				if call.ID == "" || call.Function.Name == "" || !json.Valid([]byte(call.Function.Arguments)) {
					return nil, apperror.New("incompleteToolArguments", nil)
				}
				var input map[string]any
				if err := json.Unmarshal([]byte(call.Function.Arguments), &input); err != nil || input == nil {
					return nil, apperror.New("incompleteToolArguments", nil)
				}
				blocks = append(blocks, map[string]any{"type": "tool_use", "id": call.ID, "name": call.Function.Name, "input": input})
			}
			if len(blocks) > 0 { result = append(result, msg{Role: "assistant", Content: blocks}) }
		case "tool":
			if message.ToolCallID == "" { return nil, apperror.New("incompleteToolArguments", nil) }
			block := map[string]any{"type": "tool_result", "tool_use_id": message.ToolCallID, "content": message.Content}
			if len(result) > 0 && result[len(result)-1].Role == "user" {
				if blocks, ok := result[len(result)-1].Content.([]map[string]any); ok {
					result[len(result)-1].Content = append(blocks, block)
					continue
				}
			}
			result = append(result, msg{Role: "user", Content: []map[string]any{block}})
		}
	}
	request := map[string]any{
		"model": profile.Model, "max_tokens": 8192, "stream": true, "messages": result,
	}
	if len(system) > 0 { request["system"] = strings.Join(system, "\n\n") }
	if profile.ToolsEnabled {
		request["tools"] = []any{map[string]any{
			"name": "propose_command",
			"description": "The app is already connected over SSH. Propose a raw POSIX shell command on the current remote server; execution requires the application's permission mode.",
			"input_schema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"target_id": map[string]string{"type": "string", "description": "Use the exact authorized tab_id when operating multiple SSH sessions"},
					"command": map[string]string{"type": "string", "description": "Raw shell command without ssh/scp wrappers"},
					"purpose": map[string]string{"type": "string"},
					"cwd": map[string]string{"type": "string", "description": "Absolute remote working directory"},
				},
				"required": []string{"command", "purpose", "cwd"},
				"additionalProperties": false,
			},
		}, map[string]any{
			"name": "propose_parallel_inspection",
			"description": "Run one strictly read-only inspection command simultaneously on all authorized SSH sessions and return labeled results.",
			"input_schema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"command": map[string]string{"type": "string"},
					"purpose": map[string]string{"type": "string"},
					"cwd": map[string]string{"type": "string", "description": "Absolute directory valid on every target, usually /"},
				},
				"required": []string{"command", "purpose", "cwd"},
				"additionalProperties": false,
			},
		}}
	}
	return json.Marshal(request)
}

func (p *AnthropicAdapter) RequestSize(profile domain.APIProfile, messages []Message) (int, error) {
	body, err := encodeAnthropicRequest(profile, messages)
	return len(body), err
}

func (p *AnthropicAdapter) Stream(ctx context.Context, profile domain.APIProfile, key string, messages []Message, emit func(Delta)) (Reply, error) {
	endpoint, err := NormalizeAnthropicEndpoint(profile.BaseURL)
	if err != nil { return Reply{}, err }
	if strings.TrimSpace(profile.Model) == "" {
		return Reply{}, apperror.New("enterAModelName", nil)
	}
	body, err := encodeAnthropicRequest(profile, messages)
	if err != nil { return Reply{}, err }
	if len(body) > 2*1024*1024 {
		return Reply{}, apperror.New("conversationTooLongClearTheChatAndRetry", nil)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil { return Reply{}, apperror.New("invalidApiRequest", nil) }
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("anthropic-version", "2023-06-01")
	if key != "" { request.Header.Set("x-api-key", key) }
	response, err := p.client.Do(request)
	if err != nil {
		if ctx.Err() != nil { return Reply{}, ctx.Err() }
		return Reply{}, apperror.New("apiConnectionFailedCheckTheEndpointNetworkAnd", nil)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Reply{}, apperror.New("apiHttpStatus", map[string]any{"status": response.StatusCode})
	}
	if !strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		return Reply{}, apperror.New("apiDidNotReturnAnSseStreamCheck", nil)
	}
	return parseAnthropicSSE(response.Body, emit)
}

type anthropicEvent struct {
	Type string `json:"type"`
	Index int `json:"index"`
	ContentBlock struct {
		Type string `json:"type"`
		ID string `json:"id"`
		Name string `json:"name"`
		Input json.RawMessage `json:"input"`
	} `json:"content_block"`
	Delta struct {
		Type string `json:"type"`
		Text string `json:"text"`
		PartialJSON string `json:"partial_json"`
		StopReason string `json:"stop_reason"`
	} `json:"delta"`
}

func parseAnthropicSSE(reader io.Reader, emit func(Delta)) (Reply, error) {
	scanner := bufio.NewScanner(io.LimitReader(reader, 8*1024*1024+1))
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	var data []string
	calls := map[int]*ToolCall{}
	reply := Reply{}
	size := 0
	seenStop := false
	stopReason := ""
	consume := func() error {
		if len(data) == 0 { return nil }
		payload := strings.Join(data, "\n")
		data = nil
		var event anthropicEvent
		if err := json.Unmarshal([]byte(payload), &event); err != nil {
			return apperror.New("invalidApiStreamNoExecutableCommandWasGenerated", nil)
		}
		switch event.Type {
		case "error":
			return apperror.New("apiReportedAnErrorDuringStreamingNoExecutable", nil)
		case "content_block_start":
			if event.Index < 0 || event.Index > 64 {
				return apperror.New("tooManyToolCalls", nil)
			}
			if event.ContentBlock.Type == "tool_use" {
				if len(calls) >= 16 { return apperror.New("tooManyToolCalls", nil) }
				input := string(event.ContentBlock.Input)
				if input == "" || input == "null" { input = "{}" }
				calls[event.Index] = &ToolCall{ID: event.ContentBlock.ID, Type: "function",
					Function: Function{Name: event.ContentBlock.Name, Arguments: input}}
			}
		case "content_block_delta":
			switch event.Delta.Type {
			case "text_delta":
				size += len(event.Delta.Text)
				if size > 2*1024*1024 { return apperror.New("aiOutputLimitExceeded", nil) }
				reply.Text += event.Delta.Text
				if emit != nil && event.Delta.Text != "" { emit(Delta{Kind: "text", Text: event.Delta.Text}) }
			case "input_json_delta":
				call := calls[event.Index]
				if call == nil { return apperror.New("incompleteToolArguments", nil) }
				// The initial input is usually {}; the deltas replace it.
				if call.Function.Arguments == "{}" { call.Function.Arguments = "" }
				call.Function.Arguments += event.Delta.PartialJSON
				size += len(event.Delta.PartialJSON)
				if size > 2*1024*1024 { return apperror.New("aiOutputLimitExceeded", nil) }
			}
		case "message_delta":
			if event.Delta.StopReason != "" { stopReason = event.Delta.StopReason }
		case "message_stop":
			seenStop = true
		}
		return nil
	}
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if err := consume(); err != nil { return Reply{}, err }
			if seenStop { break }
			continue
		}
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if err := scanner.Err(); err != nil {
		return Reply{}, apperror.New("failedToReadApiStream", nil)
	}
	if len(data) > 0 {
		if err := consume(); err != nil { return Reply{}, err }
	}
	if !seenStop {
		return Reply{}, apperror.New("apiStreamInterruptedNoExecutableCommandWasGenerated", nil)
	}
	if stopReason != "end_turn" && stopReason != "tool_use" {
		return Reply{}, apperror.New("aiOutputEndedIncompletelyShortenTheRequestOr", nil)
	}
	indexes := make([]int, 0, len(calls))
	for index := range calls { indexes = append(indexes, index) }
	sort.Ints(indexes)
	for _, index := range indexes {
		call := calls[index]
		if call.ID == "" || call.Function.Name == "" || !json.Valid([]byte(call.Function.Arguments)) {
			return Reply{}, apperror.New("incompleteToolArguments", nil)
		}
		var params map[string]any
		if err := json.Unmarshal([]byte(call.Function.Arguments), &params); err != nil || params == nil {
			return Reply{}, apperror.New("incompleteToolArguments", nil)
		}
		reply.ToolCalls = append(reply.ToolCalls, *call)
	}
	return reply, nil
}
