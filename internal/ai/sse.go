package ai

import (
	"bufio"
	"encoding/json"
	"github.com/hctty27/openshell/internal/apperror"
	"io"
	"strings"
)

type chunk struct {
	Error   json.RawMessage `json:"error"`
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
			Calls   []struct {
				Index    int      `json:"index"`
				ID       string   `json:"id"`
				Type     string   `json:"type"`
				Function Function `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		Finish *string `json:"finish_reason"`
	} `json:"choices"`
}

func parseSSE(r io.Reader, emit func(Delta)) (Reply, error) {
	scanner := bufio.NewScanner(io.LimitReader(r, 8*1024*1024+1))
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	reply := Reply{}
	calls := map[int]*ToolCall{}
	var data []string
	finished := false
	done := false
	size := 0
	var finishReason string
	consume := func() error {
		if len(data) == 0 {
			return nil
		}
		payload := strings.Join(data, "\n")
		data = nil
		if payload == "[DONE]" {
			done = true
			return nil
		}
		var c chunk
		if e := json.Unmarshal([]byte(payload), &c); e != nil {
			return apperror.New("invalidApiStreamNoExecutableCommandWasGenerated", nil)
		}
		if len(c.Error) > 0 && string(c.Error) != "null" {
			return apperror.New("apiReportedAnErrorDuringStreamingNoExecutable", nil)
		}
		if len(c.Choices) == 0 {
			return nil
		}
		v := c.Choices[0]
		size += len(v.Delta.Content)
		if size > 2*1024*1024 {
			return apperror.New("aiOutputLimitExceeded", nil)
		}
		reply.Text += v.Delta.Content
		if emit != nil && v.Delta.Content != "" {
			emit(Delta{Kind: "text", Text: v.Delta.Content})
		}
		for _, d := range v.Delta.Calls {
			if d.Index < 0 || d.Index > 15 {
				return apperror.New("tooManyToolCalls", nil)
			}
			call := calls[d.Index]
			if call == nil {
				call = &ToolCall{Type: "function"}
				calls[d.Index] = call
			}
			call.ID += d.ID
			call.Function.Name += d.Function.Name
			call.Function.Arguments += d.Function.Arguments
			size += len(d.Function.Arguments)
			if size > 2*1024*1024 {
				return apperror.New("aiOutputLimitExceeded", nil)
			}
		}
		if v.Finish != nil {
			finished = true
			finishReason = *v.Finish
		}
		return nil
	}
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if e := consume(); e != nil {
				return Reply{}, e
			}
			if done {
				break
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if e := scanner.Err(); e != nil {
		return Reply{}, apperror.New("failedToReadApiStream", nil)
	}
	if len(data) > 0 {
		if e := consume(); e != nil {
			return Reply{}, e
		}
	}
	if !finished || (!done && finishReason != "stop" && finishReason != "tool_calls") {
		return Reply{}, apperror.New("apiStreamInterruptedNoExecutableCommandWasGenerated", nil)
	}
	if finishReason != "stop" && finishReason != "tool_calls" {
		return Reply{}, apperror.New("aiOutputEndedIncompletelyShortenTheRequestOr", nil)
	}
	for i := 0; i < len(calls); i++ {
		c := calls[i]
		if c == nil || c.ID == "" || c.Function.Name == "" || !json.Valid([]byte(c.Function.Arguments)) {
			return Reply{}, apperror.New("incompleteToolArguments", nil)
		}
		reply.ToolCalls = append(reply.ToolCalls, *c)
	}
	return reply, nil
}
