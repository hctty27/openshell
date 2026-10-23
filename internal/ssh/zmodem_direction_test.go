package sshclient

import (
	"bytes"
	"strings"
	"testing"
)

func TestZmodemDirectionWriterPreservesByteStreamAndDetectsSplitHeaders(t *testing.T) {
	var output bytes.Buffer
	var directions []string
	writer := &zmodemDirectionWriter{
		dst: &output,
		onDirection: func(direction string) { directions = append(directions, direction) },
	}
	stream := []string{
		"before **\x18B01",
		"0123456789ab",
		" payload ",
		"**\x18B00abcdef012345",
		" after",
	}
	for _, part := range stream {
		if _, err := writer.Write([]byte(part)); err != nil {
			t.Fatal(err)
		}
	}
	if got := output.String(); got != strings.Join(stream, "") {
		t.Fatalf("SSH data changed: %q", got)
	}
	if got := strings.Join(directions, ","); got != "upload,download" {
		t.Fatalf("unexpected directions: %q", got)
	}
}

func TestZmodemDirectionWriterIgnoresNormalTerminalOutput(t *testing.T) {
	var output bytes.Buffer
	called := false
	writer := &zmodemDirectionWriter{
		dst: &output,
		onDirection: func(string) { called = true },
	}
	if _, err := writer.Write([]byte("root@server:~# echo ready\r\nready\r\n")); err != nil {
		t.Fatal(err)
	}
	if called {
		t.Fatal("normal terminal output must not start a transfer")
	}
}
