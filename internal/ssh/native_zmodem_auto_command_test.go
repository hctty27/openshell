package sshclient

import (
	"bytes"
	"encoding/base64"
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
		{"missing prompt", []string{"rz\r"}, false, "rz\r", "", ""},
		{"unsupported options", []string{"rz -y\r"}, true, "rz -y\r", "", ""},
		{"relative path", []string{"sz report.bin\r"}, true, "sz report.bin\r", "", ""},
		{"unsafe command", []string{"sz /tmp/a;rm -rf /\r"}, true, "sz /tmp/a;rm -rf /\r", "", ""},
		{"quoted spaces", []string{"sz '/tmp/a b'\r"}, true, "sz '/tmp/a b'\r", "", ""},
		{"empty line", []string{"\r"}, true, "\r", "", ""},
		{"history editing", []string{"r", "\x1b[A", "z\r"}, true, "r\x1b[Az\r", "", ""},
		{"backspace editing", []string{"r", "\x7f", "z\r"}, true, "r\x7fz\r", "", ""},
		{"multiline paste", []string{"rz\rwhoami\r"}, true, "rz\rwhoami\r", "", ""},
		{"newline", []string{"rz\n"}, true, "rz\n", "", ""},
		{"long input", []string{strings.Repeat("r", nativeAutoCommandMaxLength+10)+"\r"}, true, strings.Repeat("r", nativeAutoCommandMaxLength+10)+"\r", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var tracker nativeAutoInputTracker
			var actual bytes.Buffer
			var direction, remote string
			for _, part := range tc.chunks {
				wire, d, p := tracker.prepare([]byte(part), tc.ready)
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
		{"unknown shell", false, true, "rz\r", false},
		{"disabled", true, false, "rz\r", false},
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

func TestNativeAutoCommandMissingSidecarFallsBackBeforeEnter(t *testing.T) {
	m, ref, input, events := nativeAutoTestManager(t, true, true)
	m.ConfigureNativeZmodemAuto(filepath.Join(t.TempDir(), "not-found.exe"))
	nativeAutoType(t, m, ref, "rz\r")
	if input.String() != "rz\r" || len(events) != 0 {
		t.Fatalf("unavailable sidecar intercepted the legacy rz command: %q", input.String())
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

func TestNativeAutoCommandBlocksInProgramAndAfterEditing(t *testing.T) {
	m, ref, input, events := nativeAutoTestManager(t, true, true)
	nativeAutoType(t, m, ref, "r")
	nativeAutoType(t, m, ref, "\x7f")
	nativeAutoType(t, m, ref, "z\r")
	if input.String() != "r\x7fz\r" || len(events) != 0 {
		t.Fatal("edited command must stay on legacy path")
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
