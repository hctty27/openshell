package ai

import (
	"encoding/json"
	"github.com/hctty27/openshell/internal/domain"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"
)

type Preview struct {
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
}

var ansi = regexp.MustCompile("\\x1b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\x07]*(?:\\x07|\\x1b\\\\))")
var bearer = regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+`)
var secret = regexp.MustCompile(`(?i)((?:password|passwd|pass|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|client[_-]?secret|secret|密码)\b["\x27]?\s*[:=]\s*["\x27]?)([^\s,;"\x27}\\]+)`)
var urlCredential = regexp.MustCompile(`(?i)(://[^/\s:@]+:)[^@/\s]+(@)`)
var privateKey = regexp.MustCompile(`(?s)-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----`)

func Redact(text string) string {
	text = privateKey.ReplaceAllString(text, "[PRIVATE KEY REDACTED]")
	text = bearer.ReplaceAllString(text, "${1}[REDACTED]")
	text = secret.ReplaceAllString(text, "${1}[REDACTED]")
	return urlCredential.ReplaceAllString(text, "${1}[REDACTED]${2}")
}
func BuildPreview(text string, maxLines, maxBytes int) Preview {
	text = ansi.ReplaceAllString(text, "")
	p := Preview{Text: strings.ToValidUTF8(text, "�")}
	lines := strings.Split(p.Text, "\n")
	if len(lines) > maxLines {
		p.Text = strings.Join(lines[len(lines)-maxLines:], "\n")
		p.Truncated = true
	}
	if len(p.Text) > maxBytes {
		p.Text = p.Text[len(p.Text)-maxBytes:]
		for len(p.Text) > 0 && !utf8.RuneStart(p.Text[0]) {
			p.Text = p.Text[1:]
		}
		p.Truncated = true
	}
	return p
}

// BuildOutputPreview keeps both the beginning and end of long command output.
// The first lines often identify the operation; the tail usually contains errors.
func BuildOutputPreview(text string, maxBytes int) Preview {
	text = strings.ToValidUTF8(ansi.ReplaceAllString(Redact(text), ""), "�")
	if len(text) <= maxBytes {
		return Preview{Text: text}
	}
	if maxBytes <= 0 {
		return Preview{Truncated: true}
	}
	const marker = "\n...[truncated]...\n"
	if maxBytes <= len(marker)+8 {
		return BuildPreview(text, 10000, maxBytes)
	}
	headEnd := (maxBytes - len(marker)) / 3
	for headEnd > 0 && !utf8.RuneStart(text[headEnd]) {
		headEnd--
	}
	tailStart := len(text) - (maxBytes - len(marker) - headEnd)
	for tailStart < len(text) && !utf8.RuneStart(text[tailStart]) {
		tailStart++
	}
	return Preview{Text: text[:headEnd] + marker + text[tailStart:], Truncated: true}
}

type ConversationStore struct {
	mu       sync.Mutex
	messages map[string][]Message
}

func NewConversations() *ConversationStore {
	return &ConversationStore{messages: map[string][]Message{}}
}
func (c *ConversationStore) Append(tab string, message Message) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.messages[tab] = append(c.messages[tab], message)
}
func (c *ConversationStore) Messages(tab string) []Message {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Message(nil), c.messages[tab]...)
}
func (c *ConversationStore) Clear(tab string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.messages, tab)
}

func BuildToolResult(command, cwd string, result domain.CommandResult) string {
	type payload struct {
		Command        string `json:"command"`
		Cwd            string `json:"cwd"`
		Status         string `json:"status"`
		Reason         string `json:"reason"`
		ExitCode       *int   `json:"exitCode"`
		DurationMillis int64  `json:"durationMillis"`
		Stdout         string `json:"stdout"`
		Stderr         string `json:"stderr"`
		Truncated      bool   `json:"truncated"`
		Targets        []any  `json:"targets,omitempty"`
	}
	cmd := BuildPreview(Redact(command), 10000, 1200)
	dir := BuildPreview(cwd, 10000, 512)
	limit := 3072
	for {
		out := BuildOutputPreview(result.Stdout, limit)
		errout := BuildOutputPreview(result.Stderr, limit)
		reason := BuildPreview(Redact(result.Reason), 10000, 1024)
		targets := make([]any, 0, len(result.TargetResults))
		if len(result.TargetResults) > 0 {
			for _, item := range result.TargetResults {
				perTargetLimit := 2400 / len(result.TargetResults)
				targets = append(targets, map[string]any{
					"target_id": item.Ref.TabID, "status": item.Result.Status,
					"exitCode": item.Result.ExitCode,
					"stdout": BuildOutputPreview(item.Result.Stdout, perTargetLimit).Text,
					"stderr": BuildOutputPreview(item.Result.Stderr, perTargetLimit / 2).Text,
					"truncated": item.Result.Truncated,
				})
			}
			out.Text = ""
			errout.Text = ""
		}
		data, _ := json.Marshal(payload{cmd.Text, dir.Text, result.Status, reason.Text, result.ExitCode, result.DurationMillis, out.Text, errout.Text, result.Truncated || cmd.Truncated || dir.Truncated || reason.Truncated || out.Truncated || errout.Truncated, targets})
		if len(data) <= 8192 {
			return string(data)
		}
		limit /= 2
	}
}

 
// SanitizeResult removes credentials before results reach the conversation,
// display events, or LLM context. Parallel target outputs are covered too.
func SanitizeResult(result domain.CommandResult) domain.CommandResult {
    result.Stdout = Redact(result.Stdout)
    result.Stderr = Redact(result.Stderr)
    result.Reason = Redact(result.Reason)
    for i := range result.TargetResults {
        result.TargetResults[i].Result = SanitizeResult(result.TargetResults[i].Result)
    }
    for key, v := range result.ReasonParams {
        if value, ok := v.(string); ok { result.ReasonParams[key] = Redact(value) }
    }
    return result
}
