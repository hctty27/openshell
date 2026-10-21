package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/hctty27/openshell/internal/domain"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Function struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}
type ToolCall struct {
	ID       string   `json:"id"`
	Type     string   `json:"type"`
	Function Function `json:"function"`
}
type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
}
type Delta struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}
type Reply struct {
	Text      string     `json:"text"`
	ToolCalls []ToolCall `json:"toolCalls"`
}
type Provider struct{ client *http.Client }

func NewProvider() *Provider {
	return &Provider{client: &http.Client{Timeout: 5 * time.Minute, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		return errors.New("API 重定向已阻止，请直接填写最终地址")
	}}}
}
func NormalizeEndpoint(base string) (string, error) {
	u, e := url.Parse(strings.TrimSpace(base))
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("请输入不含凭据、参数和片段的 API 地址")
	}
	if u.Scheme != "https" {
		ip := net.ParseIP(u.Hostname())
		if u.Scheme != "http" || !(strings.EqualFold(u.Hostname(), "localhost") || ip != nil && ip.IsLoopback()) {
			return "", errors.New("远程 API 必须使用 HTTPS，本机服务可使用 HTTP")
		}
	}
	u.Path = strings.TrimRight(u.Path, "/")
	if !strings.HasSuffix(u.Path, "/chat/completions") {
		u.Path += "/chat/completions"
	}
	u.RawPath = ""
	return u.String(), nil
}
func (p *Provider) Stream(ctx context.Context, profile domain.APIProfile, key string, messages []Message, emit func(Delta)) (Reply, error) {
	endpoint, e := NormalizeEndpoint(profile.BaseURL)
	if e != nil {
		return Reply{}, e
	}
	if strings.TrimSpace(profile.Model) == "" {
		return Reply{}, errors.New("请填写模型名称")
	}
	request := map[string]any{"model": profile.Model, "messages": messages, "stream": true}
	if profile.ToolsEnabled {
		request["tools"] = []any{map[string]any{"type": "function", "function": map[string]any{"name": "propose_command", "description": "应用已经通过 SSH 登录。命令将通过当前已认证连接直接在远程服务器执行，无需再次登录。提交原始 POSIX shell 命令，不要使用 ssh/scp/sftp/sshpass 包装。用户确认后才执行。", "parameters": map[string]any{"type": "object", "properties": map[string]any{"command": map[string]string{"type": "string", "description": "直接在当前远程服务器运行的 shell 命令；不要添加 ssh 登录前缀。例如 ps -eo pid,ppid,etime,args | grep '[j]ava'"}, "purpose": map[string]string{"type": "string"}, "cwd": map[string]string{"type": "string", "description": "绝对工作目录"}}, "required": []string{"command", "purpose", "cwd"}, "additionalProperties": false}}}}
	}
	body, e := json.Marshal(request)
	if e != nil {
		return Reply{}, e
	}
	if len(body) > 2*1024*1024 {
		return Reply{}, errors.New("对话过长，请清空对话后重试")
	}
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if e != nil {
		return Reply{}, errors.New("无效 API 请求")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	response, e := p.client.Do(req)
	if e != nil {
		if ctx.Err() != nil {
			return Reply{}, ctx.Err()
		}
		return Reply{}, errors.New("API 连接失败，请检查地址、网络和证书")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Reply{}, fmt.Errorf("API 返回 HTTP %d（401：密钥错误；429：限额；5xx：服务异常）。未自动重试", response.StatusCode)
	}
	if !strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		return Reply{}, errors.New("API 未返回 SSE 流，请检查是否兼容 Chat Completions")
	}
	return parseSSE(response.Body, emit)
}
