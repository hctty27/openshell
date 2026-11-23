package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCheckAIProviderReportsSuccessAndCommonFailures(t *testing.T) {
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" { http.NotFound(w, r); return }
		switch r.Header.Get("Authorization") {
		case "Bearer good":
			_ = json.NewDecoder(r.Body).Decode(&got)
			_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"p"}}]}`))
		case "Bearer html":
			_, _ = w.Write([]byte(`<html>login</html>`))
		default:
			http.Error(w, `{"error":"invalid key"}`, http.StatusUnauthorized)
		}
	}))
	defer server.Close()
	ctx := context.Background()
	if _, err := checkAIProvider(ctx, server.URL+"/v1", "good", "gpt-test"); err != nil { t.Fatal(err) }
	if got["model"] != "gpt-test" || got["stream"] != false || got["max_tokens"] != float64(1) {
		t.Fatalf("unexpected probe payload: %v", got)
	}
	for _, tc := range []struct{ base, key, code string }{
		{server.URL + "/v1", "bad", "aiTestUnauthorized"},
		{server.URL + "/wrong", "good", "aiTestNotFound"},
		{server.URL + "/v1", "html", "aiTestUnexpectedResponse"},
		{"http://127.0.0.1:1", "good", "aiTestUnreachable"},
	} {
		_, err := checkAIProvider(ctx, tc.base, tc.key, "m")
		if err == nil || !strings.Contains(err.Error(), `"code":"`+tc.code+`"`) {
			t.Errorf("%s/%s: expected %s, got %v", tc.base, tc.key, tc.code, err)
		}
	}
}
