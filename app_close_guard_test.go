package main

import (
	"context"
	"testing"
)

func TestCloseGuardRequiresFrontendConfirmation(t *testing.T) {
	var requests []string
	quitCalls := 0
	app := &App{
		emit: func(name string, _ any) {
			requests = append(requests, name)
		},
		quit: func() { quitCalls++ },
	}
	ctx := context.Background()

	if app.beforeClose(ctx) {
		t.Fatal("close should not be blocked before the frontend is ready")
	}
	if len(requests) != 0 {
		t.Fatal("close request should not be emitted before frontend initialization")
	}

	app.SetCloseGuardReady(true)
	if !app.beforeClose(ctx) {
		t.Fatal("native window close must be cancelled until user confirmation")
	}
	if len(requests) != 1 || requests[0] != "app:quit-requested" {
		t.Fatalf("unexpected close request events: %v", requests)
	}
	if quitCalls != 0 {
		t.Fatal("native close must not quit before approval")
	}

	app.QuitConfirmed()
	if quitCalls != 1 {
		t.Fatalf("expected one approved quit, got %d", quitCalls)
	}
	if app.beforeClose(ctx) {
		t.Fatal("confirmed quit must be allowed to complete")
	}
	if len(requests) != 1 {
		t.Fatal("confirmed quit must not open a second confirmation dialog")
	}
}

func TestCloseGuardCanBeDisabledDuringFrontendTeardown(t *testing.T) {
	app := &App{emit: func(string, any) {}}
	app.SetCloseGuardReady(true)
	app.SetCloseGuardReady(false)

	if app.beforeClose(context.Background()) {
		t.Fatal("unregistered frontend must not block application shutdown")
	}
}
