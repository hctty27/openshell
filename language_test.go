package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestLanguagePreference(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	a, err := newApp(path, &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	check := func(app *App, want string) {
		t.Helper()
		state, err := app.State()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(state)
		var data map[string]any
		json.Unmarshal(b, &data)
		if data["language"] != want {
			t.Fatalf("language=%v, want %s", data["language"], want)
		}
	}
	check(a, "en")
	if err := a.SavePreference("language", "zh-CN"); err != nil {
		t.Fatal(err)
	}
	if err := a.SavePreference("language", "fr"); err == nil {
		t.Fatal("accepted unsupported language")
	}
	check(a, "zh-CN")
	a.shutdown(context.Background())
	b, err := newApp(path, &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer b.shutdown(context.Background())
	check(b, "zh-CN")
	if err := b.store.SetPreference(b.ctx, "language", "invalid"); err != nil {
		t.Fatal(err)
	}
	check(b, "en")
}
