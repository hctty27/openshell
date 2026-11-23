package sshclient

// Bash prompt integration is not installed automatically. A future
// connection-scoped installer must own stdin until it receives CHALLENGE,
// send its 128-bit nonce in a separate SSH write, and consume READY before
// allowing user commands. Bash read -s hides the nonce from PTY echo.
// The nonce stays in a non-exported variable, not in the echoed bootstrap.
//
// This hook records the command exit status before any previous scalar or
// array PROMPT_COMMAND entries execute. A matching marker is *not* a remote
// server authentication mechanism, and is only useful if installation has
// been acknowledged before the remote ZMODEM program starts.
const (
	nativePassiveBashHookChallenge = "\x1b]777;OpenShellPassiveHookChallenge\x07"
	nativePassiveBashHookReady     = "\x1b]777;OpenShellPassiveHookReady\x07"
	// nativePassiveBashHookProbePrefix starts the reply to the shell probe.
	// It is followed by $BASH_VERSION (empty outside Bash) and BEL.
	nativePassiveBashHookProbePrefix = "\x1b]777;OpenShellPassiveHookProbe;"
)

// nativePassiveShellProbe asks the shell, before anything Bash-specific is
// typed, whether it is Bash. It is valid in POSIX sh, dash, ash, ksh, zsh,
// Bash and fish and does nothing else. The leading space keeps it out of
// the history where HISTCONTROL/HIST_IGNORE_SPACE or fish honour that.
func nativePassiveShellProbe() string {
	return " printf '\\033]777;OpenShellPassiveHookProbe;%s\\007' \"$BASH_VERSION\"\r"
}

func nativePassiveBashHookBootstrap() string {
	// The bootstrap ends by removing itself and the probe from the Bash
	// history: only entries that contain the OpenShellPassiveHook marker
	// are deleted, so nothing of the user's history can be lost.
	return " if [ -n \"${BASH_VERSION-}\" ]; then builtin printf '\\033]777;OpenShellPassiveHookChallenge\\007'; IFS= read -r -s __openshell_native_nonce; if [[ \"$__openshell_native_nonce\" =~ ^[0-9a-f]{32}$ ]]; then __openshell_native_passive_prompt() { local __os_pc_code=$?; builtin printf '\\033]777;OpenShellNativeZmodem;%s;%d\\007' \"$__openshell_native_nonce\" \"$__os_pc_code\"; return \"$__os_pc_code\"; }; case \"$(declare -p PROMPT_COMMAND 2>/dev/null)\" in \"declare -a\"* ) PROMPT_COMMAND=(__openshell_native_passive_prompt \"${PROMPT_COMMAND[@]}\");; * ) PROMPT_COMMAND=\"__openshell_native_passive_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}\";; esac; for __os_i in 1 2; do __os_h=$(builtin history 1); case \"$__os_h\" in *OpenShellPassiveHook*) __os_h=${__os_h#\"${__os_h%%[0-9]*}\"}; builtin history -d \"${__os_h%%[!0-9]*}\" 2>/dev/null;; esac; done; unset __os_i __os_h; builtin printf '\\033]777;OpenShellPassiveHookReady\\007'; fi; fi\r"
}
