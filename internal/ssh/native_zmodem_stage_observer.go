package sshclient

import (
	"context"
	"time"
)

// nativeZmodemStageObserver is used only by opt-in stress tests.
// No timings, file paths, credentials or terminal data are emitted by default.
type nativeZmodemStageObserver func(name string, elapsed time.Duration)

type nativeZmodemStageObserverKey struct{}

func withNativeZmodemStageObserver(ctx context.Context, observer nativeZmodemStageObserver) context.Context {
	if observer == nil {
		return ctx
	}
	return context.WithValue(ctx, nativeZmodemStageObserverKey{}, observer)
}

func observeNativeZmodemStage(ctx context.Context, name string, started time.Time) {
	if ctx == nil {
		return
	}
	if observer, ok := ctx.Value(nativeZmodemStageObserverKey{}).(nativeZmodemStageObserver); ok {
		observer(name, time.Since(started))
	}
}
