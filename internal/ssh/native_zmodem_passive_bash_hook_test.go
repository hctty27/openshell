package sshclient

import (
	"os/exec"
	"runtime"
	"strings"
	"testing"
)

func TestNativePassiveBashPromptHookEmitsSessionBoundExitAndPreservesPromptCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Bash integration fixture runs on the Linux SSH CI runner")
	}
	if _, err := exec.LookPath("bash"); err != nil { t.Skip("Bash unavailable") }

	bootstrap := strings.TrimSuffix(nativePassiveBashHookBootstrap(), "\r")
	if strings.Contains(bootstrap, testNativePassiveSessionToken) {
		t.Fatal("the nonce must not appear in a shell command echoed to the PTY")
	}
	for _, tc := range []struct{
		name, initial string
	}{
		{"scalar", "PROMPT_COMMAND='printf PROMPT_SCALAR'"},
		{"array", "PROMPT_COMMAND=('printf PROMPT_ARRAY')"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			script := tc.initial + "; " + bootstrap +
				"; false; __openshell_native_passive_prompt" +
				"; true; __openshell_native_passive_prompt" +
				"; declare -p PROMPT_COMMAND"
			cmd := exec.Command("bash", "--noprofile", "--norc", "-c", script)
			cmd.Stdin = strings.NewReader(testNativePassiveSessionToken + "\n")
			combined, err := cmd.CombinedOutput()
			if err != nil { t.Fatalf("Bash hook failed: %v %q", err, combined) }
			output := string(combined)
			if !strings.Contains(output, nativePassiveBashHookChallenge) ||
				!strings.Contains(output, nativePassiveBashHookReady) {
				t.Fatalf("missing staged nonce challenge/ready markers: %q", output)
			}
			prefix := "\x1b]777;OpenShellNativeZmodem;" + testNativePassiveSessionToken + ";"
			if !strings.Contains(output, prefix+"1\x07") ||
				!strings.Contains(output, prefix+"0\x07") {
				t.Fatalf("Bash PROMPT_COMMAND did not capture foreground exit code: %q", output)
			}
			previous := "PROMPT_SCALAR"
			if tc.name == "array" { previous = "PROMPT_ARRAY" }
			if !strings.Contains(output, previous) {
				t.Fatalf("existing prompt hook was overwritten: %q", output)
			}
		})
	}
}

func TestNativePassiveBashPromptHookRejectsMalformedNonce(t *testing.T) {
	if runtime.GOOS == "windows" { t.Skip("Linux Bash hook fixture") }
	if _, err := exec.LookPath("bash"); err != nil { t.Skip("Bash unavailable") }
	bootstrap := strings.TrimSuffix(nativePassiveBashHookBootstrap(), "\r")
	command := exec.Command("bash", "--noprofile", "--norc", "-c",
		bootstrap+"; declare -F __openshell_native_passive_prompt || true")
	command.Stdin = strings.NewReader("wrong-secret\n")
	out, err := command.CombinedOutput()
	if err != nil { t.Fatal(err) }
	if strings.Contains(string(out), nativePassiveBashHookReady) ||
		strings.Contains(string(out), "__openshell_native_passive_prompt") {
		t.Fatalf("unverified nonce installed a recovery hook: %q", out)
	}
}
