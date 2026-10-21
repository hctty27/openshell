package apperror

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestEnvelopePreservesCodeParametersAndCause(t *testing.T) {
	cause := errors.New("socket closed")
	err := Wrap("apiHttpStatus", cause, map[string]any{"status": 429})
	if !errors.Is(err, cause) {
		t.Fatal("lost cause")
	}
	var payload struct {
		Code   string         `json:"code"`
		Params map[string]any `json:"params"`
		Detail string         `json:"detail"`
	}
	if e := json.Unmarshal([]byte(strings.TrimPrefix(err.Error(), "OPENSHELL_ERROR:")), &payload); e != nil {
		t.Fatal(e)
	}
	if payload.Code != "apiHttpStatus" || payload.Params["status"] != float64(429) || payload.Detail != "socket closed" {
		t.Fatalf("%+v", payload)
	}
}
