package ai

import (
	"context"
	"fmt"

	"github.com/hctty27/openshell/internal/domain"
)

type Function struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}
type ToolCall struct {
	ID       string   `json:"id"`
	Type     string   `json:"type"`
	Function Function `json:"function"`
}
type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
}
type Delta struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}
type Reply struct {
	Text      string     `json:"text"`
	ToolCalls []ToolCall `json:"toolCalls"`
}
// Adapter isolates protocol-specific streaming and context-size accounting.
// New providers can be added without changing conversation or tool execution code.
type Adapter interface {
	Stream(context.Context, domain.APIProfile, string, []Message, func(Delta)) (Reply, error)
	RequestSize(domain.APIProfile, []Message) (int, error)
}

type Provider struct {
	adapter   Adapter
	anthropic Adapter
}

func NewProvider() *Provider {
	return &Provider{
		adapter: NewChatCompletionsAdapter(),
		anthropic: NewAnthropicAdapter(),
	}
}

func NewProviderWithAdapter(adapter Adapter) *Provider {
	return &Provider{adapter: adapter}
}

func (p *Provider) selectAdapter(profile domain.APIProfile) (Adapter, error) {
	switch profile.Provider {
	case "", "openai":
		return p.adapter, nil
	case "anthropic":
		if p.anthropic != nil {
			return p.anthropic, nil
		}
	}
	return nil, fmt.Errorf("unsupported API provider %q", profile.Provider)
}

func (p *Provider) Stream(ctx context.Context, profile domain.APIProfile, key string, messages []Message, emit func(Delta)) (Reply, error) {
	adapter, err := p.selectAdapter(profile)
	if err != nil { return Reply{}, err }
	return adapter.Stream(ctx, profile, key, messages, emit)
}

func (p *Provider) RequestSize(profile domain.APIProfile, messages []Message) (int, error) {
	adapter, err := p.selectAdapter(profile)
	if err != nil { return 0, err }
	return adapter.RequestSize(profile, messages)
}
