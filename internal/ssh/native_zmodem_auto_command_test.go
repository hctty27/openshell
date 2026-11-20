package sshclient

import (
	"bytes"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hctty27/openshell/internal/domain"
	"golang.org/x/crypto/ssh"
)

func TestNativeAutoCommandTrackerPreservesUnrecognizedTerminalInput(t *testing.T) {
	cases := []struct {
		name string
		chunks []string
		ready bool
		wire string
		direction string
		remote string
	}{
		{"upload", []string{"r", "z", "\r"}, true, "rz\x15", "upload", ""},
		{"download", []string{"sz /tmp/report.bin\r"}, true, "sz /tmp/report.bin\x15", "download", "/tmp/report.bin"},
		{"missing prompt fails closed", []string{"rz\r"}, false, "rz\x15", "reject-unavailable", ""},
		{"unknown prompt ordinary command unchanged", []string{"redis-cli\r"}, false, "redis-cli\r", "", ""},
		{"overwrite short option", []string{"rz -y\r"}, true, "rz -y\x15", "upload-overwrite", ""},
		{"overwrite long option", []string{"rz --overwrite\r"}, true, "rz --overwrite\x15", "upload-overwrite", ""},
		{"overwrite quiet first", []string{"rz -q -y\r"}, true, "rz -q -y\x15", "upload-overwrite", ""},
		{"overwrite quiet last", []string{"rz -y -q\r"}, true, "rz -y -q\x15", "upload-overwrite", ""},
		{"overwrite with long option and quiet", []string{"rz --overwrite -q\r"}, true, "rz --overwrite -q\x15", "upload-overwrite", ""},
		{"duplicate overwrite rejected", []string{"rz -y --overwrite\r"}, true, "rz -y --overwrite\x15", "reject-unsupported", ""},
		{"unsupported upload option", []string{"rz -a\r"}, true, "rz -a\x15", "reject-unsupported", ""},
		{"overwrite after option terminator rejected", []string{"rz -- -y\r"}, true, "rz -- -y\x15", "reject-unsupported", ""},
		{"relative path", []string{"sz report.bin\r"}, true, "sz report.bin\x15", "download", "report.bin"},
		{"unsupported shell chain blocked", []string{"sz /tmp/a;rm -rf /\r"}, true, "sz /tmp/a;rm -rf /\x15", "reject-unsupported", ""},
		{"quoted spaces", []string{"sz '/tmp/a b'\r"}, true, "sz '/tmp/a b'\x15", "download", "/tmp/a b"},
		{"empty line", []string{"\r"}, true, "\r", "", ""},
		{"multi download rejected before remote command", []string{"sz -q -- one.bin 'two files.bin'\r"}, true, "sz -q -- one.bin 'two files.bin'\x15", "reject-multi", ""},
		{"unicode download", []string{"sz '中文 文件.bin'\r"}, true, "sz '中文 文件.bin'\x15", "download", "中文 文件.bin"},
		{"escaped space", []string{"sz name\\ with\\ spaces.bin\r"}, true, "sz name\\ with\\ spaces.bin\x15", "download", "name with spaces.bin"},
		{"upload quiet", []string{"rz -q\r"}, true, "rz -q\x15", "upload", ""},
		{"overwrite split input", []string{"r", "z", " ", "-", "y", "\r"}, true, "rz -y\x15", "upload-overwrite", ""},
		{"shell expansion blocked", []string{"sz \"$HOME/a.bin\"\r"}, true, "sz \"$HOME/a.bin\"\x15", "reject-unsupported", ""},
		{"glob blocked", []string{"sz *.bin\r"}, true, "sz *.bin\x15", "reject-unsupported", ""},
		{"home expansion blocked", []string{"sz ~/file.bin\r"}, true, "sz ~/file.bin\x15", "reject-unsupported", ""},
		{"history editing", []string{"r", "\x1b[A", "z\r"}, true, "r\x1b[Az\r", "", ""},
		{"backspace editing not a transfer", []string{"r", "\x7f", "z\r"}, true, "r\x7fz\r", "", ""},
		{"fix typo with delete", []string{"rzz", "\x7f", "\r"}, true, "rzz\x7f\x15", "upload", ""},
		{"fix typo with backspace", []string{"rzz", "\b", "\r"}, true, "rzz\b\x15", "upload", ""},
		{"edit overwrite flag", []string{"rz -yx", "\x7f", "\r"}, true, "rz -yx\x7f\x15", "upload-overwrite", ""},
		{"edit UTF-8 path", []string{"sz '中文错", "\x7f", "文.bin'\r"}, true, "sz '中文错\x7f文.bin'\x15", "download", "中文文.bin"},
		{"Ctrl-U clears the typed line", []string{"rz -y", "\x15", "sz one.bin\r"}, true, "rz -y\x15sz one.bin\x15", "download", "one.bin"},
		{"CRLF is one entered command", []string{"rz\r\n"}, true, "rz\x15", "upload", ""},
		{"multiline with later ZMODEM", []string{"echo hello\rsz a.bin\r"}, true, "\x15", "reject-multiline", ""},
		{"multiline with prior partial ZMODEM", []string{"rz", "\rwhoami\r"}, true, "rz\x15", "reject-multiline", ""},
		{"multiline paste rejected", []string{"rz\rwhoami\r"}, true, "\x15", "reject-multiline", ""},
		{"newline", []string{"rz\n"}, true, "rz\x15", "upload", ""},
		{"long input", []string{strings.Repeat("r", nativeAutoCommandMaxLength+10)+"\r"}, true, strings.Repeat("r", nativeAutoCommandMaxLength+10)+"\r", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var tracker nativeAutoInputTracker
			var actual bytes.Buffer
			var direction, remote string
			for _, part := range tc.chunks {
				wire, d, p := tracker.prepare([]byte(part), tc.ready, true)
				actual.Write(wire)
				if d != "" { direction, remote = d, p }
			}
			if actual.String() != tc.wire || direction != tc.direction || remote != tc.remote {
				t.Fatalf("got %q, %q, %q; expected %q, %q, %q", actual.String(), direction, remote, tc.wire, tc.direction, tc.remote)
			}
		})
	}
}

func nativeAutoTestManager(t *testing.T, ready bool, enabled bool) (*Manager, domain.ConnectionRef, *bytes.Buffer, chan map[string]any) {
	t.Helper()
	events := make(chan map[string]any, 4)
	m := NewManager(nil, func(name string, payload any) {
		if name == "ssh:native-zmodem-auto-intent" { events <- payload.(map[string]any) }
	})
	ref := domain.ConnectionRef{TabID: "auto", SessionID: "ssh", Generation: 1}
	input := &bytes.Buffer{}
	c := &connection{
		ref: ref, session: domain.Session{ID: ref.SessionID, Name: "Linux"},
		client: &ssh.Client{}, terminal: &ssh.Session{}, stdin: input,
		inputGate: newTerminalInputGate(input, input), outputGate: newTerminalOutputGate(input),
		history: NewHistory(1024),
	}
	if ready {
		c.readiness.observe([]byte("root@host:~# "))
		c.readiness.mu.Lock()
		c.readiness.lastOutput = time.Now().Add(-time.Second)
		c.readiness.mu.Unlock()
	}
	m.connections[ref.TabID] = c
	if enabled {
		executable, err := filepath.Abs(os.Args[0])
		if err != nil { t.Fatal(err) }
		m.ConfigureNativeZmodemAuto(executable)
	}
	return m, ref, input, events
}

func nativeAutoType(t *testing.T, m *Manager, ref domain.ConnectionRef, data string) {
	t.Helper()
	if err := m.Write(ref, base64.StdEncoding.EncodeToString([]byte(data))); err != nil {
		t.Fatalf("Write %q: %v", data, err)
	}
}

func TestNativeAutoCommandRequiresReadyExactSessionAndWorkingSidecar(t *testing.T) {
	for _, tc := range []struct {
		name string
		ready bool
		enabled bool
		want string
		intercept bool
	}{
		{"ready", true, true, "rz\x15", true},
		{"unknown shell", false, true, "rz\x15", false},
		{"disabled", true, false, "rz\x15", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, ref, input, events := nativeAutoTestManager(t, tc.ready, tc.enabled)
			nativeAutoType(t, m, ref, "r")
			nativeAutoType(t, m, ref, "z")
			nativeAutoType(t, m, ref, "\r")
			if got := input.String(); got != tc.want {
				t.Fatalf("unsafe remote command: %q != %q", got, tc.want)
			}
			select {
			case event := <-events:
				if !tc.intercept || event["direction"] != "upload" || event["sessionName"] != "Linux" || event["ref"] != ref {
					t.Fatalf("unexpected intent event: %+v", event)
				}
			default:
				if tc.intercept { t.Fatal("missing native intent") }
			}
		})
	}
}

func TestNativeAutoCommandMissingSidecarRejectsBeforeEnter(t *testing.T) {
	m, ref, input, events := nativeAutoTestManager(t, true, true)
	m.ConfigureNativeZmodemAuto(filepath.Join(t.TempDir(), "not-found.exe"))
	nativeAutoType(t, m, ref, "rz\r")
	if input.String() != "rz\x15" || len(events) != 0 {
		t.Fatalf("unavailable sidecar was not rejected before remote execution: %q", input.String())
	}
}

func TestNativeAutoCommandRejectsStaleGeneration(t *testing.T) {
	m, ref, input, events := nativeAutoTestManager(t, true, true)
	stale := ref
	stale.Generation++
	if err := m.Write(stale, base64.StdEncoding.EncodeToString([]byte("rz\r"))); err == nil {
		t.Fatal("stale terminal command was accepted")
	}
	if input.Len() != 0 || len(events) != 0 { t.Fatal("stale intent reached an active terminal") }
}

func TestNativeAutoCommandBackspaceAndPasteSafetyAtManagerWrite(t *testing.T) {
	cases := []struct { name string; parts []string; wire string; expectedIntent string; expectedError bool }{
		{"backspace to rz", []string{"rzz", "\x7f", "\r"}, "rzz\x7f\x15", "upload", false},
		{"backspace to rz -y", []string{"rz -yx", "\x7f", "\r"}, "rz -yx\x7f\x15", "upload-overwrite", false},
		{"multiline paste", []string{"rz\rwhoami\r"}, "\x15", "", true},
		{"paste after partial command", []string{"rz", "\rwhoami\r"}, "rz\x15", "", true},
		{"LF newline", []string{"rz\n"}, "rz\x15", "upload", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m, ref, wire, events := nativeAutoTestManager(t, true, true)
			var rejected []string
			oldEmit := m.emit
			m.emit = func(name string, payload any) {
				oldEmit(name, payload)
				if name == "ssh:native-zmodem-command-error" {
					rejected = append(rejected, payload.(map[string]any)["error"].(string))
				}
			}
			for _, part := range tc.parts { nativeAutoType(t, m, ref, part) }
			if got := wire.String(); got != tc.wire { t.Fatalf("got wire %q, want %q", got, tc.wire) }
			if tc.expectedError && len(rejected) != 1 { t.Fatalf("expected rejection, got %v", rejected) }
			if !tc.expectedError && len(rejected) != 0 { t.Fatalf("unexpected rejection: %v", rejected) }
			if tc.expectedIntent == "" {
				if len(events) != 0 { t.Fatal("unsafe paste started a file picker") }
			} else {
				select {
				case event := <-events:
					if event["direction"] != tc.expectedIntent { t.Fatalf("intent mismatch: %v", event) }
				default: t.Fatal("native picker missing")
				}
			}
		})
	}
}

func TestNativeAutoCommandBlocksInProgramAndAfterEditing(t *testing.T) {
	m, ref, input, events := nativeAutoTestManager(t, true, true)
	nativeAutoType(t, m, ref, "r")
	nativeAutoType(t, m, ref, "\x7f")
	nativeAutoType(t, m, ref, "z\r")
	if input.String() != "r\x7fz\r" || len(events) != 0 {
		t.Fatal("edited command must stay on legacy path")
	}
}

func TestNativeAutoCommandPickerBlocksTypingUntilReleased(t *testing.T) {
	m, ref, input, events := nativeAutoTestManager(t, true, true)
	nativeAutoType(t, m, ref, "rz\r")
	select {
	case intent := <-events:
		if intent["direction"] != "upload" { t.Fatalf("unexpected intent: %v", intent) }
	default:
		t.Fatal("native picker did not open")
	}
	if got := input.String(); got != "rz\x15" { t.Fatalf("unexpected initial wire: %q", got) }
	key := base64.StdEncoding.EncodeToString([]byte("pwd\r"))
	if err := m.Write(ref, key); !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("picker did not reserve user input: %v", err)
	}
	if _, err := m.AcquireAITerminal(ref); err == nil {
		t.Fatal("terminal AI acquired the SSH session during file selection")
	}
	stale := ref
	stale.Generation++
	m.ReleaseNativeZmodemSelection(stale)
	if err := m.Write(ref, key); !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("stale picker cancellation released live SSH input: %v", err)
	}
	m.ReleaseNativeZmodemSelection(ref)
	if err := m.Write(ref, key); err != nil {
		t.Fatalf("selection cancellation did not restore typing: %v", err)
	}
	if got := input.String(); got != "rz\x15pwd\r" {
		t.Fatalf("unexpected output after picker cancellation: %q", got)
	}
}

func TestNativeAutoCommandDoesNotInterceptMySQLPrompt(t *testing.T) {
	m, ref, input, events := nativeAutoTestManager(t, false, true)
	c := m.connections[ref.TabID]
	c.readiness.observe([]byte("Welcome to the MySQL monitor\r\nmysql> "))
	c.readiness.mu.Lock()
	c.readiness.lastOutput = time.Now().Add(-time.Second)
	c.readiness.mu.Unlock()
	if c.readiness.readyProgram() != "mysql" { t.Fatal("fixture was not recognized as MySQL") }
	nativeAutoType(t, m, ref, "rz\r")
	if input.String() != "rz\r" || len(events) != 0 {
		t.Fatalf("MySQL command was incorrectly treated as shell ZMODEM: %q", input.String())
	}
}

// Overwrite must survive the actual terminal input gate and arrive at the
// file picker as a distinct mode, never as a silent normal upload.
func TestNativeAutoCommandOverwriteEmitsExactIntent(t *testing.T) {
	m, ref, input, events := nativeAutoTestManager(t, true, true)
	nativeAutoType(t, m, ref, "rz -y\r")
	if got := input.String(); got != "rz -y\x15" {
		t.Fatalf("remote command was not intercepted: %q", got)
	}
	select {
	case event := <-events:
		if event["direction"] != "upload-overwrite" || event["ref"] != ref ||
			event["remotePath"] != "" {
			t.Fatalf("overwrite intent lost: %+v", event)
		}
	default:
		t.Fatal("missing overwrite picker intent")
	}
}

// A newly emitted Bash prompt must allow native rz/sz interception
// immediately. AI execution retains its separate 250 ms settle check.
func TestNativeAutoCommandFreshShellPromptWithoutSettlingDelay(t *testing.T) {
	for _, tc := range []struct {
		name, command, direction, path string
	}{
		{"upload", "rz", "upload", ""},
		{"overwrite", "rz -y", "upload-overwrite", ""},
		{"download", "sz report.bin", "download", "report.bin"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, ref, input, events := nativeAutoTestManager(t, false, true)
			c := m.connections[ref.TabID]
			c.readiness.observe([]byte("file list\r\n[root@localhost hc]# "))
			if err := c.readiness.checkReady(); err == nil {
				t.Fatal("test fixture must still be inside the AI settle window")
			}
			for _, ch := range tc.command {
				nativeAutoType(t, m, ref, string(ch))
			}
			nativeAutoType(t, m, ref, "\r")
			if got, want := input.String(), tc.command+"\x15"; got != want {
				t.Fatalf("unexpected remote input: got %q want %q", got, want)
			}
			select {
			case event := <-events:
				if event["direction"] != tc.direction || event["remotePath"] != tc.path {
					t.Fatalf("incorrect picker intent: %+v", event)
				}
			default:
				t.Fatal("fresh prompt did not trigger the native picker")
			}
		})
	}
}

// A missing prompt may not trigger a picker, but sending Enter would start
// remote lrzsz and cause unsolicited ZMODEM frames and terminal quarantine.
func TestNativeAutoCommandUnknownPromptRejectsWithoutRemoteEnter(t *testing.T) {
	var notices []string
	m, ref, input, events := nativeAutoTestManager(t, false, true)
	m.emit = func(name string, payload any) {
		if name == "ssh:native-zmodem-command-error" {
			notices = append(notices, payload.(map[string]any)["error"].(string))
		}
	}
	for _, cmd := range []string{"rz", "rz -y", "sz report.bin"} {
		input.Reset()
		nativeAutoType(t, m, ref, cmd+"\r")
		if got := input.String(); got != cmd+"\x15" {
			t.Fatalf("%q escaped into remote program: %q", cmd, got)
		}
	}
	if len(events) != 0 || len(notices) != 3 {
		t.Fatalf("unexpected picker intents or rejection notices: events=%d notices=%v", len(events), notices)
	}
}

// A recognized REPL or alternate-screen application must not be treated as
// a verified POSIX Shell simply because its input resembles rz/sz.
func TestNativeAutoCommandKnownREPLAndAlternateScreenBypass(t *testing.T) {
	for _, name := range []string{"mysql", "alternate"} {
		t.Run(name, func(t *testing.T) {
			m, ref, input, events := nativeAutoTestManager(t, false, true)
			c := m.connections[ref.TabID]
			if name == "mysql" {
				c.readiness.observe([]byte("Welcome to the MySQL monitor\r\nmysql> "))
			} else {
				c.readiness.observe([]byte("\x1b[?1049h"))
			}
			nativeAutoType(t, m, ref, "rz\r")
			if input.String() != "rz\r" || len(events) != 0 {
				t.Fatalf("modified a non-Shell input: %q", input.String())
			}
		})
	}
}
