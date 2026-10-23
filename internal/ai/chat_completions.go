package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
)

// ChatCompletionsAdapter implements the existing OpenAI-compatible SSE protocol.
type ChatCompletionsAdapter struct {
	client *http.Client
}

func NewChatCompletionsAdapter() *ChatCompletionsAdapter {
	return &ChatCompletionsAdapter{client: &http.Client{
		Timeout: 5 * time.Minute,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return apperror.New("apiRedirectBlockedEnterTheFinalEndpointDirectly", nil)
		},
	}}
}

func NormalizeEndpoint(base string) (string, error) {
	u, e := url.Parse(strings.TrimSpace(base))
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", apperror.New("enterAnApiUrlWithoutCredentialsQueryParameters", nil)
	}
	if u.Scheme != "https" {
		ip := net.ParseIP(u.Hostname())
		if u.Scheme != "http" || !(strings.EqualFold(u.Hostname(), "localhost") || ip != nil && ip.IsLoopback()) {
			return "", apperror.New("remoteApisRequireHttpsLocalServicesMayUse", nil)
		}
	}
	u.Path = strings.TrimRight(u.Path, "/")
	if !strings.HasSuffix(u.Path, "/chat/completions") {
		u.Path += "/chat/completions"
	}
	u.RawPath = ""
	return u.String(), nil
}
func (p *ChatCompletionsAdapter) Stream(ctx context.Context, profile domain.APIProfile, key string, messages []Message, emit func(Delta)) (Reply, error) {
	endpoint, e := NormalizeEndpoint(profile.BaseURL)
	if e != nil {
		return Reply{}, e
	}
	if strings.TrimSpace(profile.Model) == "" {
		return Reply{}, apperror.New("enterAModelName", nil)
	}
	body, e := encodeRequest(profile, messages)
	if e != nil {
		return Reply{}, e
	}
	if len(body) > 2*1024*1024 {
		return Reply{}, apperror.New("conversationTooLongClearTheChatAndRetry", nil)
	}
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if e != nil {
		return Reply{}, apperror.New("invalidApiRequest", nil)
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
		return Reply{}, apperror.New("apiConnectionFailedCheckTheEndpointNetworkAnd", nil)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Reply{}, apperror.New("apiHttpStatus", map[string]any{"status": response.StatusCode})
	}
	if !strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		return Reply{}, apperror.New("apiDidNotReturnAnSseStreamCheck", nil)
	}
	return parseSSE(response.Body, emit)
}

func encodeRequest(profile domain.APIProfile, messages []Message) ([]byte, error) {
	request := map[string]any{"model": profile.Model, "messages": messages, "stream": true}
	if profile.ToolsEnabled {
		request["tools"] = []any{map[string]any{"type": "function", "function": map[string]any{"name": "propose_command", "description": "The app is already connected via SSH. Submit a raw POSIX shell command for the current remote server without ssh/scp/sftp/sshpass wrappers. Execution is controlled by the application permission mode.", "parameters": map[string]any{"type": "object", "properties": map[string]any{"command": map[string]string{"type": "string", "description": "Raw shell command on the current remote server, without ssh login prefixes. For example: ps -eo pid,ppid,etime,args | grep '[j]ava'"}, "purpose": map[string]string{"type": "string"}, "cwd": map[string]string{"type": "string", "description": "Absolute remote working directory"}}, "required": []string{"command", "purpose", "cwd"}, "additionalProperties": false}}}}
	}
	return json.Marshal(request)
}
func (p *ChatCompletionsAdapter) RequestSize(profile domain.APIProfile, messages []Message) (int, error) {
	body, e := encodeRequest(profile, messages)
	return len(body), e
}
