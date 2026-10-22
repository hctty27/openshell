package domain

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"github.com/hctty27/openshell/internal/apperror"
	"strings"
)

type Session struct {
	ID             string `json:"id"`
	GroupID        string `json:"groupId"`
	Name           string `json:"name"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
	Username       string `json:"username"`
	AuthType       string `json:"authType"`
	PrivateKeyPath string `json:"privateKeyPath"`
	CredentialRef  string `json:"credentialRef"`
	TerminalTheme  string `json:"terminalTheme,omitempty"`
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
}
type Group struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	ParentID string `json:"parentId,omitempty"`
}
type APIProfile struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	BaseURL      string `json:"baseUrl"`
	Model        string `json:"model"`
	SecretRef    string `json:"secretRef"`
	ToolsEnabled bool   `json:"toolsEnabled"`
}
type ConnectionRef struct {
	TabID      string `json:"tabId"`
	SessionID  string `json:"sessionId"`
	Generation uint64 `json:"generation"`
}
type Proposal struct {
	ID             string        `json:"id"`
	Ref            ConnectionRef `json:"ref"`
	Command        string        `json:"command"`
	Purpose        string        `json:"purpose"`
	Cwd            string        `json:"cwd"`
	TimeoutSeconds int           `json:"timeoutSeconds"`
	Status         string        `json:"status"`
	ToolCallID     string        `json:"toolCallId"`
}
type CommandResult struct {
	ReasonCode     string         `json:"reasonCode,omitempty"`
	ReasonParams   map[string]any `json:"reasonParams,omitempty"`
	Status         string         `json:"status"`
	Stdout         string         `json:"stdout"`
	Stderr         string         `json:"stderr"`
	ExitCode       *int           `json:"exitCode"`
	DurationMillis int64          `json:"durationMillis"`
	Truncated      bool           `json:"truncated"`
	Reason         string         `json:"reason"`
}
type AppError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *AppError) Error() string      { return e.Message }
func Error(code, message string) error { return &AppError{code, message} }
func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func ValidateSession(s Session) error {
	if strings.TrimSpace(s.Host) == "" || strings.ContainsAny(s.Host, "\x00\r\n\t /@") || strings.TrimSpace(s.Username) == "" || strings.ContainsAny(s.Username, "\x00\r\n") {
		return apperror.New("enterAValidHostAndUsername", nil)
	}
	if s.Port < 1 || s.Port > 65535 {
		return apperror.New("portMustBeBetween1And65535", nil)
	}
	if s.TerminalTheme != "" && s.TerminalTheme != "follow" && s.TerminalTheme != "classic" && s.TerminalTheme != "dark" && s.TerminalTheme != "light" {
		return apperror.New("unsupportedTheme", nil)
	}
	if s.AuthType != "" && s.AuthType != "password" && s.AuthType != "key" {
		return apperror.New("unsupportedAuthenticationMethod", nil)
	}
	return nil
}

type SecretStore interface {
	Get(context.Context, string) (string, error)
	Put(context.Context, string, string) error
	Delete(context.Context, string) error
}
type EventSink interface{ Emit(string, any) }
