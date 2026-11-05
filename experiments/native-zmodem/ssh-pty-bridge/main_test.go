package main

import (
	"strings"
	"testing"
)

func TestRemoteCommandQuotesHostilePaths(t *testing.T) {
	path := "/tmp/a' && touch /tmp/unsafe; echo '"
	for _, direction := range []string{"send", "receive"} {
		command, err := remoteCommand(direction, path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(command, quoteShell(path)) {
			t.Fatalf("remote path was not shell-quoted: %s", command)
		}
	}
}

func TestRemoteCommandRejectsInvalidDirectionAndNUL(t *testing.T) {
	for _, item := range []struct{ direction, path string }{
		{"unknown", "/tmp"},
		{"send", ""},
		{"receive", "/tmp/\x00bad"},
	} {
		if _, err := remoteCommand(item.direction, item.path); err == nil {
			t.Fatalf("accepted invalid request: %#v", item)
		}
	}
}

func TestVerifyLocalPathRequiresExpectedFileKind(t *testing.T) {
	dir := t.TempDir()
	if _, err := verifyLocalPath("send", dir); err == nil {
		t.Fatal("send accepted directory")
	}
	if _, err := verifyLocalPath("receive", dir); err != nil {
		t.Fatalf("receive rejected existing directory: %v", err)
	}
}
