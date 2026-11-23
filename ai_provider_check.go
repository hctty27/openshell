package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/hctty27/openshell/internal/apperror"
)

// AITestProviderRequest checks a provider before (or after) it is saved. The
// API key may be omitted for a saved provider to reuse its stored key.
type AITestProviderRequest struct {
	ProviderID string `json:"providerId"`
	BaseURL    string `json:"baseUrl"`
	APIKey     string `json:"apiKey"`
	Model      string `json:"model"`
}

type AITestProviderResult struct {
	LatencyMs int64 `json:"latencyMs"`
}

const aiProviderCheckTimeout = 20 * time.Second

func (a *App) AITestProvider(req AITestProviderRequest) (AITestProviderResult, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(req.BaseURL), "/")
	parsed, err := url.Parse(baseURL)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") ||
		parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return AITestProviderResult{}, apperror.New("aiInvalidBaseURL", nil)
	}
	model := strings.TrimSpace(req.Model)
	if model == "" || len(model) > 150 || strings.ContainsAny(model, "\r\n") {
		return AITestProviderResult{}, apperror.New("aiInvalidModelID", nil)
	}
	key := req.APIKey
	if key == "" && req.ProviderID != "" {
		provider, err := a.store.GetAIProvider(a.ctx, req.ProviderID)
		if err == nil && provider.SecretRef != "" {
			key, err = a.secrets.Get(a.ctx, provider.SecretRef)
			if err != nil { return AITestProviderResult{}, err }
		}
	}
	if key == "" { return AITestProviderResult{}, apperror.New("aiMissingAPIKey", nil) }
	ctx, cancel := context.WithTimeout(a.ctx, aiProviderCheckTimeout)
	defer cancel()
	return checkAIProvider(ctx, baseURL, key, model)
}

// checkAIProvider sends the smallest possible non-streaming completion so the
// user learns about a wrong URL, key or model before starting a task.
func checkAIProvider(ctx context.Context, baseURL, key, model string) (AITestProviderResult, error) {
	body, err := json.Marshal(map[string]any{
		"model":      model,
		"messages":   []map[string]string{{"role": "user", "content": "ping"}},
		"max_tokens": 1,
		"stream":     false,
	})
	if err != nil { return AITestProviderResult{}, err }
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil { return AITestProviderResult{}, err }
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	started := time.Now()
	resp, err := (&http.Client{Transport: aiHTTPTransport}).Do(req)
	if err != nil {
		if ctx.Err() != nil { return AITestProviderResult{}, apperror.New("aiTestTimedOut", nil) }
		return AITestProviderResult{}, apperror.Wrap("aiTestUnreachable", err, nil)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	if resp.StatusCode != http.StatusOK {
		detail := strings.TrimSpace(string(data))
		var cause error
		if detail != "" { cause = errorString(detail) }
		code := "aiTestHTTPStatus"
		switch resp.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			code = "aiTestUnauthorized"
		case http.StatusNotFound:
			code = "aiTestNotFound"
		}
		return AITestProviderResult{}, apperror.Wrap(code, cause, map[string]any{"status": resp.StatusCode})
	}
	var payload struct {
		Choices []json.RawMessage `json:"choices"`
	}
	if json.Unmarshal(data, &payload) != nil || len(payload.Choices) == 0 {
		return AITestProviderResult{}, apperror.New("aiTestUnexpectedResponse", nil)
	}
	return AITestProviderResult{LatencyMs: time.Since(started).Milliseconds()}, nil
}

type errorString string

func (e errorString) Error() string { return string(e) }
