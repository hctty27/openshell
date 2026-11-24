package main

import "testing"

// These checks prevent a Git repository's diff.external or textconv helpers
// from executing silently in either execution mode.
func TestAIGitConfiguredDiffHelpersNeedApproval(t *testing.T) {
	ask := []string{
		"git diff", "git diff HEAD", "git diff --no-ext-diff",
		"git diff --no-textconv", "git diff --no-ext-diff --no-textconv",
		"git diff --no-ext-diff --no-textconv -- path",
		"git show HEAD", "git log -p", "git log --stat",
		"git log --all -p -S needle",
		"git diff -- --no-ext-diff --no-textconv",
	}
	for _, command := range ask {
		for _, mode := range []string{"auto", "review"} {
			got := aiToolApproval(mode, "ssh_exec", "", command, "", false)
			// The one explicit double opt-out example is safe.
			wantPrompt := command != "git diff --no-ext-diff --no-textconv" &&
				command != "git diff --no-ext-diff --no-textconv -- path"
			if got.Required != wantPrompt {
				t.Errorf("%s %q: got required=%v, want %v", mode, command, got.Required, wantPrompt)
			}
		}
	}
	for _, command := range []string{
		"git diff --no-ext-diff --no-textconv",
		"git show --no-ext-diff --no-textconv HEAD",
		"git log --no-ext-diff --no-textconv -p",
		"git log -n 5 --oneline",
		"git status",
	} {
		for _, mode := range []string{"auto", "review"} {
			if got := aiToolApproval(mode, "ssh_exec", "", command, "", false); got.Required {
				t.Errorf("%s %q: unexpectedly needs approval: %+v", mode, command, got)
			}
		}
	}
}
