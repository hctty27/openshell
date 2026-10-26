package main

import (
 "context"
 "testing"
)

func TestCloseGuardRequiresFrontendAndExplicitApproval(t *testing.T) {
 var requests int
 app := &App{ctx:context.Background(), emit:func(name string, _ any) {
   if name == "app:quit-requested" { requests++ }
 }}
 if app.beforeClose(context.Background()) { t.Fatal("without frontend should allow normal shutdown") }
 app.SetCloseGuardReady(true)
 if !app.beforeClose(context.Background()) { t.Fatal("close should be intercepted while frontend is ready") }
 if requests != 1 { t.Fatalf("expected one event, got %d", requests) }
 app.SetCloseGuardReady(false)
 if app.beforeClose(context.Background()) { t.Fatal("frontend teardown must allow shutdown") }
 app.SetCloseGuardReady(true)
 app.mu.Lock()
 app.quitApproved = true
 app.mu.Unlock()
 if app.beforeClose(context.Background()) { t.Fatal("confirmed exit must pass native guard") }
}
