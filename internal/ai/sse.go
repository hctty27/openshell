package ai

import (
	"bufio"
	"encoding/json"
	"errors"
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
			return errors.New("API 流格式错误，未生成可执行命令")
		}
		if len(c.Error) > 0 && string(c.Error) != "null" {
			return errors.New("API 在输出期间报告错误，未生成可执行命令")
		}
		if len(c.Choices) == 0 {
			return nil
		}
		v := c.Choices[0]
		size += len(v.Delta.Content)
		if size > 2*1024*1024 {
			return errors.New("AI 输出超过上限")
		}
		reply.Text += v.Delta.Content
		if emit != nil && v.Delta.Content != "" {
			emit(Delta{Kind: "text", Text: v.Delta.Content})
		}
		for _, d := range v.Delta.Calls {
			if d.Index < 0 || d.Index > 15 {
				return errors.New("工具调用数量过多")
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
				return errors.New("AI 输出超过上限")
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
		return Reply{}, errors.New("API 流读取失败")
	}
	if len(data) > 0 {
		if e := consume(); e != nil {
			return Reply{}, e
		}
	}
	if !finished || (!done && finishReason != "stop" && finishReason != "tool_calls") {
		return Reply{}, errors.New("API 流中断，未生成可执行命令")
	}
	if finishReason != "stop" && finishReason != "tool_calls" {
		return Reply{}, errors.New("AI 输出未完整结束，请缩短请求或调整模型配置")
	}
	for i := 0; i < len(calls); i++ {
		c := calls[i]
		if c == nil || c.ID == "" || c.Function.Name == "" || !json.Valid([]byte(c.Function.Arguments)) {
			return Reply{}, errors.New("工具参数不完整")
		}
		reply.ToolCalls = append(reply.ToolCalls, *c)
	}
	return reply, nil
}
