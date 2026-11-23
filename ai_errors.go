package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/hctty27/openshell/internal/apperror"
)

// The model cannot read OPENSHELL_ERROR envelopes, so tool failures are
// rendered with the English catalog the UI already ships.
//
//go:embed frontend/src/locales/en/errors.json
var englishErrorCatalogJSON []byte

var (
	englishErrorCatalogOnce sync.Once
	englishErrorCatalog     map[string]string
	errorPlaceholder        = regexp.MustCompile(`{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}`)
)

func englishErrorText(code string, params map[string]any) (string, bool) {
	englishErrorCatalogOnce.Do(func() { _ = json.Unmarshal(englishErrorCatalogJSON, &englishErrorCatalog) })
	text, ok := englishErrorCatalog[code]
	if !ok {
		return "", false
	}
	return errorPlaceholder.ReplaceAllStringFunc(text, func(match string) string {
		name := errorPlaceholder.FindStringSubmatch(match)[1]
		if value, found := params[name]; found {
			return fmt.Sprint(value)
		}
		return match
	}), true
}

// aiReadableError replaces an embedded coded error with readable English and
// keeps any surrounding text (for example a command's partial output).
func aiReadableError(text string) string {
	start := strings.Index(text, apperror.Prefix)
	if start < 0 {
		return text
	}
	decoder := json.NewDecoder(strings.NewReader(text[start+len(apperror.Prefix):]))
	var payload struct {
		Code   string         `json:"code"`
		Params map[string]any `json:"params"`
		Detail string         `json:"detail"`
	}
	if err := decoder.Decode(&payload); err != nil || payload.Code == "" {
		return text
	}
	rendered, ok := englishErrorText(payload.Code, payload.Params)
	if !ok {
		rendered = payload.Code
	}
	if payload.Detail != "" {
		rendered += ": " + aiReadableError(payload.Detail)
	}
	end := start + len(apperror.Prefix) + int(decoder.InputOffset())
	return text[:start] + rendered + text[end:]
}
