package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/hctty27/openshell/internal/domain"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestNormalizeEndpoint(t *testing.T) {
	for _, base := range []string{"https://example.com/v1/", "https://example.com/v1/chat/completions"} {
		got, e := NormalizeEndpoint(base)
		if e != nil || got != "https://example.com/v1/chat/completions" {
			t.Fatalf("%q %v", got, e)
		}
	}
	if _, e := NormalizeEndpoint("http://[::1]:8080/v1"); e != nil {
		t.Fatal(e)
	}
	for _, base := range []string{"http://example.com/v1", "https://user:pass@example.com/v1", "https://example.com/v1?key=x", "file:///secret"} {
		if _, e := NormalizeEndpoint(base); e == nil {
			t.Fatal("accepted", base)
		}
	}
}
func TestSSEFragmentedToolCalls(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("missing key")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call1\",\"type\":\"function\",\"function\":{\"name\":\"propose_command\",\"arguments\":\"{\\\"command\\\":\"}}]}}]}\n\n")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"pwd\\\",\\\"purpose\\\":\\\"检查\\\",\\\"cwd\\\":\\\"/tmp\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer s.Close()
	p := NewProvider()
	reply, e := p.Stream(context.Background(), domain.APIProfile{BaseURL: s.URL, Model: "custom", ToolsEnabled: true}, "test-key", []Message{{Role: "user", Content: "检查"}}, nil)
	if e != nil {
		t.Fatal(e)
	}
	if len(reply.ToolCalls) != 1 || reply.ToolCalls[0].Function.Arguments != `{"command":"pwd","purpose":"检查","cwd":"/tmp"}` {
		t.Fatalf("%+v", reply)
	}
}
func TestSSEInvalidOrInterrupted(t *testing.T) {
	for _, body := range []string{"data: broken\n\n", "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n"} {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, body)
		}))
		_, e := NewProvider().Stream(context.Background(), domain.APIProfile{BaseURL: s.URL, Model: "m"}, "secret", []Message{}, nil)
		s.Close()
		if e == nil {
			t.Fatal("accepted incomplete SSE")
		}
	}
}
func TestAPIHTMLError(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		fmt.Fprint(w, "<html>secret-api-key</html>")
	}))
	defer s.Close()
	_, e := NewProvider().Stream(context.Background(), domain.APIProfile{BaseURL: s.URL, Model: "m"}, "secret-api-key", []Message{}, nil)
	if e == nil || strings.Contains(e.Error(), "secret-api-key") {
		t.Fatal(e)
	}
}
func TestPreviewUTF8Limits(t *testing.T) {
	v := BuildPreview(strings.Repeat("你", 40000), 200, 32768)
	if !v.Truncated || len(v.Text) > 32768 || !utf8.ValidString(v.Text) {
		t.Fatal("invalid preview")
	}
	v = BuildPreview(strings.Repeat("日志\n", 300), 200, 32768)
	if len(strings.Split(v.Text, "\n")) > 200 || !v.Truncated {
		t.Fatal(v)
	}
	if strings.Contains(Redact("Authorization: Bearer abcdef123456\npassword=hello123\napi_key=sk-secret"), "hello123") {
		t.Fatal("password leaked")
	}
}
func TestToolResultKeepsMetadataWithinLimit(t *testing.T) {
	code := 7
	text := BuildToolResult(strings.Repeat("cmd", 12000), "/tmp", domain.CommandResult{Status: "failed", ExitCode: &code, Stdout: strings.Repeat("\x00你好\n", 40000), Stderr: strings.Repeat("err\"\n", 40000)})
	if len(text) > 32768 {
		t.Fatal("result exceeds model byte limit", len(text))
	}
	var value struct {
		Status    string `json:"status"`
		ExitCode  *int   `json:"exitCode"`
		Truncated bool   `json:"truncated"`
	}
	if e := json.Unmarshal([]byte(text), &value); e != nil || value.Status != "failed" || value.ExitCode == nil || *value.ExitCode != 7 || !value.Truncated {
		t.Fatal("lost metadata", value, e)
	}
}

func TestToolDescribesAlreadyConnectedRemoteExecution(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Tools []struct {
				Function struct {
					Description string `json:"description"`
					Parameters  struct {
						Properties map[string]struct {
							Description string `json:"description"`
						} `json:"properties"`
					} `json:"parameters"`
				} `json:"function"`
			} `json:"tools"`
		}
		if e := json.NewDecoder(r.Body).Decode(&req); e != nil {
			t.Error(e)
		}
		if len(req.Tools) != 1 || !strings.Contains(req.Tools[0].Function.Description, "已经通过 SSH 登录") || !strings.Contains(req.Tools[0].Function.Parameters.Properties["command"].Description, "不要添加 ssh") {
			t.Error("tool does not explain execution location")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	_, e := NewProvider().Stream(context.Background(), domain.APIProfile{BaseURL: server.URL, Model: "m", ToolsEnabled: true}, "", []Message{{Role: "user", Content: "查看进程"}}, nil)
	if e != nil {
		t.Fatal(e)
	}
}
func TestSystemMessageExplainsAvailableRemoteTool(t *testing.T) {
	s := domain.Session{Host: "192.0.2.10", Port: 22, Username: "root"}
	enabled := SystemMessage(s, true)
	for _, text := range []string{"已经通过 SSH 登录", "propose_command", "直接在远程服务器执行", "不要再次运行 ssh", "不要声称没有 SSH 执行工具"} {
		if !strings.Contains(enabled.Content, text) {
			t.Fatalf("missing %q", text)
		}
	}
	disabled := SystemMessage(s, false)
	if !strings.Contains(disabled.Content, "普通对话模式") || !strings.Contains(disabled.Content, "操作模式") {
		t.Fatal(disabled.Content)
	}
}
