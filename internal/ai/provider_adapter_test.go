package ai

import (
	"context"
	"testing"

	"github.com/hctty27/openshell/internal/domain"
)

type testAdapter struct {
	streamed bool
	requested bool
}

func (a *testAdapter) Stream(_ context.Context, _ domain.APIProfile, _ string, _ []Message, emit func(Delta)) (Reply, error) {
	a.streamed = true
	if emit != nil {
		emit(Delta{Kind: "text", Text: "ok"})
	}
	return Reply{Text: "ok"}, nil
}

func (a *testAdapter) RequestSize(_ domain.APIProfile, _ []Message) (int, error) {
	a.requested = true
	return 42, nil
}

func TestProviderRoutesThroughAdapter(t *testing.T) {
	adapter := &testAdapter{}
	provider := NewProviderWithAdapter(adapter)
	profile := domain.APIProfile{Model: "test"}
	result, err := provider.Stream(context.Background(), profile, "", []Message{{Role: "user", Content: "hello"}}, nil)
	if err != nil || result.Text != "ok" || !adapter.streamed {
		t.Fatalf("adapter stream was not called: %+v %v", result, err)
	}
	size, err := provider.RequestSize(profile, nil)
	if err != nil || size != 42 || !adapter.requested {
		t.Fatalf("adapter size accounting was not called: %d %v", size, err)
	}
}
