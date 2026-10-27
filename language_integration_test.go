package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/hctty27/openshell/internal/domain"
	"github.com/hctty27/openshell/internal/testssh"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestAIRequestLanguageAndAutomaticFreeze(t *testing.T) {
	a, err := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.shutdown(context.Background())
	remote := testssh.Start(t)
	row, err := a.SaveSession(SaveSessionRequest{Session: domain.Session{Host: remote.Host, Port: remote.Port, Username: "root", AuthType: "password"}, Secret: "test-password", SaveSecret: true})
	if err != nil {
		t.Fatal(err)
	}
	connected, err := a.Connect("language-tab", row.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if err = a.TrustHost(connected.Challenge.ID); err != nil {
		t.Fatal(err)
	}
	connected, err = a.Connect("language-tab", row.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	var systems []string
	propose := false
    verifyNext := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
			return
		}
		systems = append(systems, req.Messages[0].Content)
		w.Header().Set("Content-Type", "text/event-stream")
		if propose {
            verifyNext = true
			propose = false
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"lang-call\",\"type\":\"function\",\"function\":{\"name\":\"propose_command\",\"arguments\":\"{\\\"command\\\":\\\"printf DONE\\\",\\\"purpose\\\":\\\"check\\\",\\\"cwd\\\":\\\"/tmp\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n")
			return
		}
        if verifyNext {
            verifyNext = false
            fmt.Fprint(w, "data: {\\\"choices\\\":[{\\\"delta\\\":{\\\"tool_calls\\\":[{\\\"index\\\":0,\\\"id\\\":\\\"lang-verify\\\",\\\"type\\\":\\\"function\\\",\\\"function\\\":{\\\"name\\\":\\\"propose_command\\\",\\\"arguments\\\":\\\"{\\\\\\\"command\\\\\\\":\\\\\\\"pwd\\\\\\\",\\\\\\\"purpose\\\\\\\":\\\\\\\"verify\\\\\\\",\\\\\\\"cwd\\\\\\\":\\\\\\\"/tmp\\\\\\\"}\\\"}}]},\\\"finish_reason\\\":\\\"tool_calls\\\"}]}\\n\\ndata: [DONE]\\n\\n")
            return
        }
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	profile, err := a.SaveAPI(SaveAPIRequest{Profile: domain.APIProfile{Name: "test", BaseURL: server.URL, Model: "test", ToolsEnabled: true}, MemoryOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	req := ChatRequest{Ref: connected.Ref, ProfileID: profile.ID, Text: "check", Operate: true}
	if _, err = a.Chat(req); err != nil {
		t.Fatal(err)
	}
	if err = a.SavePreference("language", "zh-CN"); err != nil {
		t.Fatal(err)
	}
	if _, err = a.Chat(req); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(systems[0], "Default response language: English") || !strings.Contains(systems[1], "Default response language: Simplified Chinese") {
		t.Fatalf("ordinary request languages: %v", systems)
	}
	propose = true
	before := remote.Count()
	task, err := a.StartAutomatic(req, "language-auto")
	if err != nil || task.Status != "awaiting_confirmation" {
		t.Fatal(task, err)
	}
	if remote.Count() != before {
		t.Fatal("command ran without confirmation")
	}
	if err = a.SavePreference("language", "en"); err != nil {
		t.Fatal(err)
	}
	task, err = a.ResumeAutomatic(connected.Ref, "language-auto", task.Proposal.ID, false)
	if err != nil || task.Status != "completed" {
		t.Fatal(task, err)
	}
	if !strings.Contains(systems[2], "Default response language: Simplified Chinese") || !strings.Contains(systems[3], "Default response language: Simplified Chinese") || !strings.Contains(systems[4], "Default response language: Simplified Chinese") {
		t.Fatal("automatic language changed", systems)
	}
	if remote.Count() != before+2 {
		t.Fatal("unexpected command count")
	}
	if _, err = a.StartAutomatic(req, "language-new"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(systems[5], "Default response language: English") {
		t.Fatal("new task did not use current language")
	}
}
