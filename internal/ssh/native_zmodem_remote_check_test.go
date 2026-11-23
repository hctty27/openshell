package sshclient

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestNativeRemoteCheckReportsSpecificErrorsAndHidesCommand(t *testing.T) {
	cases := []struct {
		direction, path string
		status          int
		code            string
	}{
		{"download", "missing.bin", 211, "zmodemRemoteNotFound"},
		{"download", "logs", 210, "zmodemRemoteIsDirectory"},
		{"download", "secret.bin", 212, "zmodemRemoteNotReadable"},
		{"upload", "", 213, "zmodemRemoteDirNotWritable"},
		{"upload-overwrite", "", 214, "zmodemRemoteLrzszMissing"},
		{"download", "ok.bin", 0, ""},
	}
	for _, tc := range cases {
		t.Run(tc.code, func(t *testing.T) {
			var legacy bytes.Buffer
			capture := &nativeTerminalCapturedInput{ch: make(chan []byte, 4)}
			input := newTerminalInputGate(io.Discard, capture)
			output := newTerminalOutputGate(&legacy)
			coordinator := &nativeTerminalCoordinator{input: input, output: output}
			done := make(chan error, 1)
			go func() { done <- coordinator.checkRemote(context.Background(), tc.direction, tc.path) }()
			command := string(nativeTerminalNextInput(t, capture))
			if strings.Contains(command, "rz -q") || strings.Contains(command, "sz -q") {
				t.Fatalf("check must not start a transfer: %q", command)
			}
			// Echo of the hidden command, then marker, then the next prompt.
			if _, err := output.Write([]byte(command + "\n")); err != nil { t.Fatal(err) }
			if _, err := output.Write(nativeTerminalCompletionFromCommand(t, command, tc.status)); err != nil { t.Fatal(err) }
			if _, err := output.Write([]byte("user@host:~$ ")); err != nil { t.Fatal(err) }
			select {
			case err := <-done:
				if tc.code == "" {
					if err != nil { t.Fatalf("unexpected error: %v", err) }
				} else if err == nil || !strings.Contains(err.Error(), `"`+tc.code+`"`) {
					t.Fatalf("got %v, want %s", err, tc.code)
				}
			case <-time.After(4 * time.Second):
				t.Fatal("check did not finish")
			}
			if got := legacy.String(); got != "\r\x1b[Kuser@host:~$ " {
				t.Fatalf("terminal got %q; the command echo must stay hidden and the old prompt erased", got)
			}
			if _, err := input.Write([]byte("ls")); err != nil {
				t.Fatalf("input not restored: %v", err)
			}
		})
	}
}

// The check runs in a real POSIX shell, so the generated script is valid
// and resolves relative paths in the shell's own working directory.
func TestNativeRemoteCheckCommandRunsInPOSIXShell(t *testing.T) {
	if runtime.GOOS == "windows" { t.Skip("POSIX shell semantics") }
	if _, err := exec.LookPath("sh"); err != nil { t.Skip("no sh") }
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "it's here.bin"), []byte("x"), 0o644); err != nil { t.Fatal(err) }
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil { t.Fatal(err) }
	fake := t.TempDir()
	for _, name := range []string{"rz", "sz"} {
		if err := os.WriteFile(filepath.Join(fake, name), []byte("#!/bin/sh\n"), 0o755); err != nil { t.Fatal(err) }
	}
	token := strings.Repeat("ab", 16)
	run := func(direction, path, pathEnv string) string {
		command, err := nativeInteractiveCheckCommand(direction, path, token)
		if err != nil { t.Fatal(err) }
		cmd := exec.Command("sh", "-c", strings.TrimSuffix(command, "\r"))
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "PATH="+pathEnv)
		out, err := cmd.Output()
		if err != nil { t.Fatalf("%s %q: %v", direction, path, err) }
		s := string(out)
		return s[strings.LastIndex(s, ";")+1 : len(s)-1]
	}
	path := fake + ":" + os.Getenv("PATH")
	if got := run("download", "it's here.bin", path); got != "0" { t.Fatalf("existing file: %s", got) }
	if got := run("download", "nope.bin", path); got != "211" { t.Fatalf("missing file: %s", got) }
	if got := run("download", "sub", path); got != "210" { t.Fatalf("directory: %s", got) }
	if got := run("upload", "", path); got != "0" { t.Fatalf("writable dir: %s", got) }
	if got := run("upload", "", "/nonexistent"); got != "214" { t.Fatalf("missing lrzsz: %s", got) }
	if os.Geteuid() != 0 {
		if err := os.Chmod(dir, 0o555); err != nil { t.Fatal(err) }
		defer os.Chmod(dir, 0o755)
		if got := run("upload", "", path); got != "213" { t.Fatalf("read-only dir: %s", got) }
		if err := os.Chmod(filepath.Join(dir, "it's here.bin"), 0); err != nil { t.Fatal(err) }
		if got := run("download", "it's here.bin", path); got != "212" { t.Fatalf("unreadable: %s", got) }
	}
}
