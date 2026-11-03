package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/hctty27/openshell/internal/domain"
)

type AIModel struct {
	ID string `json:"id"`
	Name string `json:"name"`
}

type AIProvider struct {
	ID string `json:"id"`
	Name string `json:"name"`
	BaseURL string `json:"baseUrl"`
	SecretRef string `json:"secretRef,omitempty"`
	HasKey bool `json:"hasKey"`
	Models []AIModel `json:"models"`
}

type AIFunction struct {
	Name string `json:"name"`
	Arguments string `json:"arguments"`
}

type AIToolCall struct {
	ID string `json:"id"`
	Type string `json:"type"`
	Function AIFunction `json:"function"`
}

type AIMessage struct {
	Role string `json:"role"`
	Content string `json:"content"`
	ToolCalls []AIToolCall `json:"tool_calls,omitempty"`
	ToolCallID string `json:"tool_call_id,omitempty"`
}

type AITargetBinding struct {
	SessionID string `json:"sessionId"`
	Name string `json:"name"`
	Host string `json:"host"`
	Port int `json:"port"`
	Username string `json:"username"`
}

type AIConversation struct {
	ID string `json:"id"`
	Title string `json:"title"`
	ProviderID string `json:"providerId"`
	ModelID string `json:"modelId"`
	Mode string `json:"mode"`
	Execution string `json:"execution,omitempty"`
	TargetNames []string `json:"targetNames"`
	TargetSessionIDs []string `json:"targetSessionIds,omitempty"`
	TargetBindings []AITargetBinding `json:"targetBindings,omitempty"`
	Messages []AIMessage `json:"messages"`
	UpdatedAt string `json:"updatedAt"`
}

func (s *Store) InitAI(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS ai_providers(id TEXT PRIMARY KEY,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_conversations(id TEXT PRIMARY KEY,data TEXT NOT NULL);`)
	return err
}

func (s *Store) AIProviders(ctx context.Context) ([]AIProvider, error) {
	return list[AIProvider](ctx, s.db, "SELECT data FROM ai_providers ORDER BY id")
}

func (s *Store) GetAIProvider(ctx context.Context, id string) (AIProvider, error) {
	var data string
	err := s.db.QueryRowContext(ctx, "SELECT data FROM ai_providers WHERE id=?", id).Scan(&data)
	if err != nil { return AIProvider{}, err }
	var p AIProvider
	if err := unmarshalAI(data, &p); err != nil { return AIProvider{}, err }
	return p, nil
}

func (s *Store) SaveAIProvider(ctx context.Context, p AIProvider) error {
	if p.ID == "" { p.ID = domain.NewID() }
	// Key existence is derived from SecretRef, never from a frontend flag.
	p.HasKey = p.SecretRef != ""
	return s.save(ctx, "INSERT INTO ai_providers(id,data)VALUES(?,?) ON CONFLICT(id)DO UPDATE SET data=excluded.data", p.ID, p)
}

func (s *Store) DeleteAIProvider(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM ai_providers WHERE id=?", id)
	return err
}

func (s *Store) AIConversations(ctx context.Context) ([]AIConversation, error) {
	return list[AIConversation](ctx, s.db, "SELECT data FROM ai_conversations ORDER BY json_extract(data,'$.updatedAt') DESC")
}

func (s *Store) GetAIConversation(ctx context.Context, id string) (AIConversation, error) {
	var data string
	err := s.db.QueryRowContext(ctx, "SELECT data FROM ai_conversations WHERE id=?", id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) { return AIConversation{}, err }
	if err != nil { return AIConversation{}, err }
	var c AIConversation
	if err := unmarshalAI(data, &c); err != nil { return AIConversation{}, err }
	return c, nil
}

func (s *Store) SaveAIConversation(ctx context.Context, c AIConversation) error {
	c.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	c.Title = strings.TrimSpace(c.Title)
	if c.Title == "" { c.Title = "新对话" }
	return s.save(ctx, "INSERT INTO ai_conversations(id,data)VALUES(?,?) ON CONFLICT(id)DO UPDATE SET data=excluded.data", c.ID, c)
}

func (s *Store) DeleteAIConversation(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM ai_conversations WHERE id=?", id)
	return err
}

func unmarshalAI(data string, v any) error { return json.Unmarshal([]byte(data), v) }
