package ai

import (
	"github.com/hctty27/openshell/internal/domain"
	"strings"
	"testing"
)

func TestSystemMessageLanguageAndExecutionRules(t *testing.T) {
	s := domain.Session{Host: "server", Port: 22, Username: "root"}
	for _, language := range []string{"en", "zh-CN"} {
		for _, mode := range []struct{ tools, auto bool }{{false, false}, {true, false}, {true, true}} {
			got := SystemMessage(s, mode.tools, language, mode.auto).Content
			wanted := "English"
			if language == "zh-CN" {
				wanted = "Simplified Chinese"
			}
			for _, part := range []string{wanted, "explicitly requests another language", "propose_command", "ssh/scp/sftp/sshpass", "absolute", "server:22", "untrusted"} {
				if !strings.Contains(got, part) {
					t.Errorf("missing %q in %s", part, got)
				}
			}
		}
	}
}
