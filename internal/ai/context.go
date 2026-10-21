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
var secret = regexp.MustCompile(`(?i)((?:password|passwd|api[_-]?key|access[_-]?token|secret|密码)\s*[:=]\s*)([^\s,;]+)`)
var privateKey = regexp.MustCompile(`(?s)-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----`)

func Redact(text string) string {
	text = privateKey.ReplaceAllString(text, "[PRIVATE KEY REDACTED]")
	text = bearer.ReplaceAllString(text, "${1}[REDACTED]")
	return secret.ReplaceAllString(text, "${1}[REDACTED]")
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
	}
	cmd := BuildPreview(Redact(command), 10000, 4096)
	dir := BuildPreview(cwd, 10000, 1024)
	limit := 12000
	for {
		out := BuildPreview(Redact(result.Stdout), 10000, limit)
		errout := BuildPreview(Redact(result.Stderr), 10000, limit)
		data, _ := json.Marshal(payload{cmd.Text, dir.Text, result.Status, result.Reason, result.ExitCode, result.DurationMillis, out.Text, errout.Text, result.Truncated || cmd.Truncated || dir.Truncated || out.Truncated || errout.Truncated})
		if len(data) <= 32768 {
			return string(data)
		}
		limit /= 2
	}
}
