package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hctty27/openshell/internal/domain"
)

func TestNormalizeAnthropicEndpoint(t *testing.T) {
	for input, expected := range map[string]string{
		"https://api.anthropic.com": "https://api.anthropic.com/v1/messages",
		"https://api.anthropic.com/v1": "https://api.anthropic.com/v1/messages",
		"https://api.anthropic.com/v1/messages": "https://api.anthropic.com/v1/messages",
		"https://proxy.example/custom/v1": "https://proxy.example/custom/v1/messages",
	} {
		result, err := NormalizeAnthropicEndpoint(input)
		if err != nil || result != expected { t.Fatalf("%s => %s, %v", input, result, err) }
	}
	for _, invalid := range []string{
		"http://remote.example/v1", "https://user:secret@example.com", "https://example.com/v1?token=private",
	} {
		if _, err := NormalizeAnthropicEndpoint(invalid); err == nil { t.Errorf("accepted invalid API URL %s", invalid) }
	}
}

func TestAnthropicProviderStreamsTextAndToolCalls(t *testing.T) {
	var received struct {
		System string `json:"system"`
		Messages []struct { Role string `json:"role"`; Content json.RawMessage `json:"content"` } `json:"messages"`
		Tools []struct { Name string `json:"name"` } `json:"tools"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/messages" { t.Errorf("endpoint %s", request.URL.Path) }
		if request.Header.Get("x-api-key") != "test-anthropic-key" ||
			request.Header.Get("anthropic-version") != "2023-06-01" ||
			request.Header.Get("Authorization") != "" {
			t.Errorf("incorrect authentication headers: %v", request.Header)
		}
		if err := json.NewDecoder(request.Body).Decode(&received); err != nil { t.Error(err) }
		w.Header().Set("Content-Type", "text/event-stream")
		events := []string{
			`{"type":"message_start","message":{"id":"msg_1"}}`,
			`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ready"}}`,
			`{"type":"content_block_stop","index":0}`,
			`{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"propose_command","input":{}}}`,
		}
		for _, event := range events { fmt.Fprintf(w, "data: %s\n\n", event) }
		pieces := []string{`{"command":"pwd",`, `"purpose":"inspect","cwd":"/"}`}
		for _, piece := range pieces {
			delta, _ := json.Marshal(map[string]any{
				"type": "content_block_delta", "index": 1,
				"delta": map[string]any{"type":"input_json_delta","partial_json":piece},
			})
			fmt.Fprintf(w, "data: %s\n\n", delta)
		}
		fmt.Fprint(w, "data: "+`{"type":"content_block_stop","index":1}`+"\n\n")
		fmt.Fprint(w, "data: "+`{"type":"message_delta","delta":{"stop_reason":"tool_use"}}`+"\n\n")
		fmt.Fprint(w, "data: "+`{"type":"message_stop"}`+"\n\n")
	}))
	defer server.Close()

	p := NewProvider()
	profile := domain.APIProfile{BaseURL: server.URL, Model:"claude-model", Provider:"anthropic",ToolsEnabled:true}
	var chunks []string
	reply, err := p.Stream(context.Background(), profile,"test-anthropic-key",[]Message{
		{Role:"system",Content:"Help with SSH."},
		{Role:"user",Content:"check directory"},
		{Role:"assistant",ToolCalls:[]ToolCall{{ID:"earlier",Type:"function",Function:Function{Name:"propose_command",Arguments:`{"command":"pwd","purpose":"inspect","cwd":"/"}`}}}},
		{Role:"tool",ToolCallID:"earlier",Content:"/root"},
		{Role:"user",Content:"now propose another command"},
	},func(delta Delta){chunks=append(chunks,delta.Text)})
	if err!=nil {t.Fatal(err)}
	if reply.Text!="ready" || strings.Join(chunks,"")!="ready" || len(reply.ToolCalls)!=1 ||
		reply.ToolCalls[0].ID!="toolu_1" || reply.ToolCalls[0].Function.Name!="propose_command" ||
		!json.Valid([]byte(reply.ToolCalls[0].Function.Arguments)) {t.Fatalf("reply: %+v",reply)}
	if received.System!="Help with SSH." || len(received.Messages)!=4 || len(received.Tools)!=2 ||
		received.Tools[0].Name!="propose_command" || received.Tools[1].Name!="propose_parallel_inspection" {t.Fatalf("request: %+v",received)}
	if !strings.Contains(string(received.Messages[2].Content), "tool_result") ||
		!strings.Contains(string(received.Messages[1].Content), "tool_use") {
		t.Fatalf("history missing tool blocks: %+v",received.Messages)
	}
}

func TestAnthropicStreamRequiresCompleteMessage(t *testing.T) {
	for _, suffix := range []string{
		`{"type":"message_delta","delta":{"stop_reason":"end_turn"}}`,
		`{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}`+"\n\ndata: "+`{"type":"message_stop"}`,
	} {
		_, err := parseAnthropicSSE(strings.NewReader("data: "+suffix+"\n\n"), nil)
		if err==nil { t.Fatalf("accepted incomplete or truncated stream: %s",suffix) }
	}
	if _,err:=NewProvider().RequestSize(domain.APIProfile{Provider:"unsupported"},nil);err==nil {
		t.Fatal("unknown provider should not fall back silently")
	}
}
