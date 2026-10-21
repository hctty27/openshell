package domain

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
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
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
}
type Group struct {
	ID   string `json:"id"`
	Name string `json:"name"`
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
	Status         string `json:"status"`
	Stdout         string `json:"stdout"`
	Stderr         string `json:"stderr"`
	ExitCode       *int   `json:"exitCode"`
	DurationMillis int64  `json:"durationMillis"`
	Truncated      bool   `json:"truncated"`
	Reason         string `json:"reason"`
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
		return errors.New("请填写有效主机和用户名")
	}
	if s.Port < 1 || s.Port > 65535 {
		return errors.New("端口必须在 1–65535 之间")
	}
	if s.AuthType != "" && s.AuthType != "password" && s.AuthType != "key" {
		return errors.New("不支持的认证方式")
	}
	return nil
}

type SecretStore interface {
	Get(context.Context, string) (string, error)
	Put(context.Context, string, string) error
	Delete(context.Context, string) error
}
type EventSink interface{ Emit(string, any) }
