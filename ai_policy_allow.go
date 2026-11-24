package main

import (
	"path"
	"regexp"
	"strings"
)

// aiShellSimpleParse is the strict parser behind the allowlist. It accepts
// only a pipeline of plain words: whole-word '...' or "..." quotes (without
// $, ` or \ inside), | between stages and the harmless redirections
// 2>/dev/null, >/dev/null and 2>&1. Everything else - ;, &&, ||, &, (),
// {}, $, `, \, !, <, other redirections, quotes inside a word, assignments
// and comments - makes ok false, because OpenShell can no longer tell what
// the shell will run or which path it will open.
func aiShellSimpleParse(command string) (stages [][]string, ok bool) {
	s := strings.TrimSpace(command)
	if s == "" {
		return nil, false
	}
	var stage []string
	var cur strings.Builder
	inWord := false
	endWord := func() {
		if inWord {
			stage = append(stage, cur.String())
			cur.Reset()
			inWord = false
		}
	}
	boundary := func(i int) bool { return i >= len(s) || s[i] == ' ' || s[i] == '\t' || s[i] == '|' }
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == ' ' || c == '\t':
			endWord()
		case c == '|':
			endWord()
			if i+1 < len(s) && s[i+1] == '|' || len(stage) == 0 {
				return nil, false
			}
			stages = append(stages, stage)
			stage = nil
		case c == '\'' || c == '"':
			if inWord {
				return nil, false // sha""dow, e"tc"/shadow
			}
			end := strings.IndexByte(s[i+1:], c)
			if end < 0 {
				return nil, false
			}
			body := s[i+1 : i+1+end]
			if strings.ContainsAny(body, "\n\r\x00") || c == '"' && strings.ContainsAny(body, "$`\\!") {
				return nil, false
			}
			i += end + 1
			if !boundary(i + 1) {
				return nil, false
			}
			stage = append(stage, body)
		case !inWord && (c == '>' || c == '1' || c == '2'):
			matched := false
			for _, r := range []string{"2>/dev/null", "1>/dev/null", ">/dev/null", "2>&1"} {
				if strings.HasPrefix(s[i:], r) && boundary(i+len(r)) {
					i += len(r) - 1
					matched = true
					break
				}
			}
			if !matched {
				if c == '>' {
					return nil, false
				}
				cur.WriteByte(c)
				inWord = true
			}
		case c >= 0x80 || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
			strings.IndexByte("_./:=,+@%^-*?[]", c) >= 0:
			cur.WriteByte(c)
			inWord = true
		case c == '~':
			cur.WriteByte(c)
			inWord = true
		case c == '#' && inWord:
			cur.WriteByte(c)
		default:
			// ; & < > ( ) { } $ ` \ ! newline, a leading # and control
			// characters.
			return nil, false
		}
	}
	endWord()
	if len(stage) == 0 {
		return nil, false
	}
	return append(stages, stage), true
}

// aiShellSafeCommandDirs are the only directories an allowlisted program may
// be named from; ./ls or /tmp/ls could be anything.
var aiShellSafeCommandDirs = map[string]bool{"": true, "/bin": true, "/usr/bin": true, "/sbin": true, "/usr/sbin": true, "/usr/local/bin": true}

// aiShellReadOnly reports whether a command can run without approval: it
// parses cleanly and every stage of the pipeline is an allowlisted read-only
// program with arguments that keep it read-only. It is used by both modes;
// anything it cannot prove safe needs approval.
func aiShellReadOnly(command string) bool {
	stages, ok := aiShellSimpleParse(command)
	if !ok {
		return false
	}
	for _, words := range stages {
		name := words[0]
		dir := ""
		if i := strings.LastIndexByte(name, '/'); i >= 0 {
			dir, name = name[:i], name[i+1:]
			if dir == "" {
				dir = "/"
			}
		}
		if !aiShellSafeCommandDirs[dir] || strings.ContainsAny(name, "*?[]=~") || !aiShellReadOnlyCommands[name] {
			return false
		}
		if !aiShellReadOnlyArgs(name, words[1:]) {
			return false
		}
	}
	return true
}

// aiShortFlags reports whether a short option group such as -tulpn contains
// any of letters. Long options and plain arguments never match.
func aiShortFlags(arg, letters string) bool {
	if len(arg) < 2 || arg[0] != '-' || arg[1] == '-' {
		return false
	}
	for _, c := range arg[1:] {
		if c >= '0' && c <= '9' {
			break // -n5: the rest is a value
		}
		if strings.ContainsRune(letters, c) {
			return true
		}
	}
	return false
}

func aiHasLongFlag(args []string, flags ...string) bool {
	for _, a := range args {
		for _, f := range flags {
			if a == f || strings.HasPrefix(a, f+"=") || strings.HasSuffix(f, "*") && strings.HasPrefix(a, strings.TrimSuffix(f, "*")) {
				return true
			}
		}
	}
	return false
}

func aiAnyShortFlags(args []string, letters string) bool {
	for _, a := range args {
		if aiShortFlags(a, letters) {
			return true
		}
	}
	return false
}

func aiShellReadOnlyArgs(name string, args []string) bool {
	sub := ""
	if len(args) > 0 {
		sub = args[0]
	}
	joined := " " + strings.Join(args, " ") + " "
	switch name {
	case "tail":
		return !aiAnyShortFlags(args, "fF") && !aiHasLongFlag(args, "--follow", "--retry")
	case "journalctl":
		return !aiAnyShortFlags(args, "f") && !aiHasLongFlag(args, "--follow", "--vacuum*", "--rotate", "--flush", "--sync",
			"--setup-keys", "--relinquish-var", "--smart-relinquish-var", "--update-catalog", "--cursor-file", "--new-id128")
	case "find":
		for _, a := range args {
			for _, p := range []string{"-exec", "-ok", "-delete", "-fprint", "-fls"} {
				if strings.HasPrefix(a, p) {
					return false
				}
			}
		}
	case "sort":
		return !aiAnyShortFlags(args, "o") && !aiHasLongFlag(args, "--output", "--compress-program")
	case "tree":
		return !aiAnyShortFlags(args, "o") && !aiHasLongFlag(args, "--output")
	case "dmesg":
		return !aiAnyShortFlags(args, "cCDEn") && !aiHasLongFlag(args, "--clear", "--read-clear", "--console-off",
			"--console-on", "--console-level")
	case "ss":
		return !aiAnyShortFlags(args, "K") && !aiHasLongFlag(args, "--kill")
	case "getent":
		for _, a := range args {
			if a == "shadow" || a == "gshadow" {
				return false
			}
		}
	case "ps":
		// BSD-style "e" (ps e, ps auxe, ps eww) prints every process'
		// environment, which often holds tokens.
		for i, a := range args {
			if strings.HasPrefix(a, "-") || i > 0 && strings.HasPrefix(args[i-1], "-") && !strings.HasPrefix(args[i-1], "--") {
				continue
			}
			if regexp.MustCompile(`^[A-Za-z]+$`).MatchString(a) && strings.Contains(a, "e") {
				return false
			}
		}
	case "file":
		return !aiAnyShortFlags(args, "C") && !aiHasLongFlag(args, "--compile")
	case "date":
		if aiAnyShortFlags(args, "s") || aiHasLongFlag(args, "--set") {
			return false
		}
		for _, a := range args {
			if !strings.HasPrefix(a, "+") && !strings.HasPrefix(a, "-") {
				return false
			}
		}
	case "hostname":
		for _, a := range args {
			if !strings.HasPrefix(a, "-") {
				return false
			}
		}
		return !aiHasLongFlag(args, "--file") && !aiAnyShortFlags(args, "F")
	case "timedatectl", "hostnamectl":
		if sub != "" && sub != "status" && sub != "show" && sub != "list-timezones" && sub != "timesync-status" {
			return false
		}
	case "systemctl":
		if !map[string]bool{"status": true, "list-units": true, "list-unit-files": true, "is-active": true, "is-enabled": true, "is-failed": true, "show": true, "cat": true, "list-timers": true, "--failed": true}[sub] {
			return false
		}
	case "docker":
		if !map[string]bool{"ps": true, "images": true, "inspect": true, "logs": true, "version": true, "info": true, "stats": true}[sub] ||
			(sub == "logs" && (aiAnyShortFlags(args[1:], "f") || aiHasLongFlag(args, "--follow"))) ||
			(sub == "stats" && !aiHasLongFlag(args, "--no-stream")) {
			return false
		}
	case "kubectl":
		if !map[string]bool{"get": true, "describe": true, "logs": true, "version": true, "top": true, "explain": true, "api-resources": true}[sub] ||
			aiAnyShortFlags(args, "fw") || aiHasLongFlag(args, "--follow", "--watch", "--watch-only", "--kubeconfig", "--token") {
			return false
		}
		if sub == "get" && regexp.MustCompile(`\bsecrets?\b`).MatchString(joined) {
			return false
		}
	case "git":
		// --output writes a file; --ext-diff and --textconv run helper
		// programs from the repository configuration.
		if aiHasLongFlag(args, "--output", "--ext-diff", "--textconv", "--exec", "--upload-pack", "--open-files-in-pager", "--paginate") ||
			aiAnyShortFlags(args[min(1, len(args)):], "oO") {
			return false
		}
		// Git may execute repository-configured diff.external / textconv helpers
		// even when the user supplied no explicit --ext-diff or --textconv.
		// Only allow diff-producing commands when both features are disabled.
		if sub == "diff" || sub == "show" || sub == "log" && aiGitLogDisplaysDiff(args[1:]) {
			if !aiGitDiffHelpersDisabled(args[1:]) {
				return false
			}
		}
		if !map[string]bool{"status": true, "log": true, "diff": true, "show": true, "rev-parse": true, "remote": true, "branch": true, "describe": true}[sub] ||
			(sub == "branch" && len(args) > 1 && args[1] != "-a" && args[1] != "-r" && args[1] != "--list" && args[1] != "-v" && args[1] != "-vv") ||
			(sub == "remote" && len(args) > 1 && args[1] != "-v") {
			return false
		}
	case "ip":
		if !map[string]bool{"a": true, "addr": true, "address": true, "r": true, "route": true, "link": true, "l": true, "-br": true, "-s": true, "neigh": true, "-4": true, "-6": true}[sub] ||
			regexp.MustCompile(`\s(add|del|delete|set|flush|change|replace|append|exec|netns|save|restore)\s`).MatchString(joined) {
			return false
		}
	}
	return true
}

// aiGitDiffHelpersDisabled demands explicit safeguards before any path
// that may render diffs. Both options must precede the pathspec separator;
// a flag written after -- names a file instead of changing Git behavior.
func aiGitDiffHelpersDisabled(args []string) bool {
	noExt, noText := false, false
	for _, a := range args {
		if a == "--" { break }
		switch a {
		case "--no-ext-diff": noExt = true
		case "--no-textconv": noText = true
		case "--ext-diff", "--textconv": return false
		}
	}
	return noExt && noText
}

// aiGitLogDisplaysDiff checks options that enable patch or diffstat output.
// Plain log metadata, such as --oneline, does not invoke diff converters.
func aiGitLogDisplaysDiff(args []string) bool {
	return aiAnyShortFlags(args, "p") ||
		aiHasLongFlag(args, "--patch", "--stat", "--numstat", "--shortstat", "--name-only",
			"--name-status", "--dirstat", "--summary", "--raw", "--check")
}

// aiShellNormalized removes the quoting and escape characters the shell
// would remove, so /etc/sha""dow, /e"tc"/shadow and sha\dow are checked as
// /etc/shadow.
func aiShellNormalized(command string) string {
	return strings.NewReplacer(`"`, "", `'`, "", `\`, "").Replace(command)
}

// aiShellSensitive reports commands that read or send credentials, also when
// the path is split by quotes or escapes.
func aiShellSensitive(command string) bool {
	for _, c := range []string{command, aiShellNormalized(command)} {
		if aiPathIsSensitive(c) || aiShellGlobSensitive(c) || aiShellExposesSecrets(c) || aiShellBulkSecrets(c) {
			return true
		}
	}
	return false
}

var aiSecretPattern = regexp.MustCompile(`(?i)passw|secret|token|credential|api[_-]?key|private`)

// aiBulkSecretRoot matches the targets of a recursive search or archive that
// covers home directories or system configuration as a whole.
var aiBulkSecretRoot = regexp.MustCompile(`^(/|/root(/.*)?|/home(/[^/]+)?/?|~[^/]*/?|/etc/?)$`)

// aiShellBulkSecrets reports recursive grep, rg or tar over a home directory,
// /etc or / (grep -r . /root, tar c /root) and recursive searches for words
// such as password or token, which would send whatever secrets they find to
// the AI provider.
func aiShellBulkSecrets(command string) bool {
	for _, segment := range aiShellSegments(command) {
		words := aiStripCommandPrefixes(aiShellFields(segment))
		if len(words) == 0 {
			continue
		}
		name := path.Base(words[0])
		args := words[1:]
		var operands []string
		for _, a := range args {
			if !strings.HasPrefix(a, "-") {
				operands = append(operands, a)
			}
		}
		recursive := false
		switch name {
		case "grep", "egrep", "fgrep", "zgrep":
			recursive = aiAnyShortFlags(args, "rR") || aiHasLongFlag(args, "--recursive", "--dereference-recursive", "--directories")
		case "rg", "ag", "ack":
			recursive = true
		case "tar", "bsdtar", "zip", "7z", "rsync", "scp", "cpio":
			for _, op := range operands {
				if aiBulkSecretRoot.MatchString(op) {
					return true
				}
			}
			continue
		case "history":
			return true
		default:
			continue
		}
		if !recursive {
			continue
		}
		for i, op := range operands {
			if aiBulkSecretRoot.MatchString(op) {
				return true
			}
			if i == 0 && aiSecretPattern.MatchString(op) {
				return true
			}
		}
	}
	return false
}

// aiPythonSafeModules may be imported by Python code that runs without
// approval in automatic mode. They compute; they do not touch files,
// processes or the network.
var aiPythonSafeModules = map[string]bool{
	"math": true, "cmath": true, "json": true, "re": true, "datetime": true, "time": true, "statistics": true,
	"collections": true, "itertools": true, "functools": true, "decimal": true, "fractions": true, "string": true,
	"textwrap": true, "random": true, "hashlib": true, "base64": true, "binascii": true, "uuid": true, "operator": true,
	"heapq": true, "bisect": true, "pprint": true, "calendar": true, "ipaddress": true, "struct": true, "enum": true,
	"dataclasses": true, "typing": true, "unicodedata": true, "difflib": true, "zlib": true,
}

var aiPythonImport = regexp.MustCompile(`(?m)^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w., ]+))`)
var aiPythonUnsafe = regexp.MustCompile(`\b(open|exec|eval|compile|__import__|getattr|setattr|delattr|globals|locals|vars|input|breakpoint|exit|quit|help|memoryview)\s*\(|__\w+__|\b(os|sys|subprocess|shutil|socket|pathlib|ctypes|importlib|pickle|marshal|builtins|signal|threading|multiprocessing|asyncio|io|tempfile|glob|urllib|http|requests)\b|(?m:^\s*[!%])`)

// aiPythonSafe reports whether a Python snippet only computes with values and
// safe standard modules. Anything else needs approval in automatic mode too.
func aiPythonSafe(code string) bool {
	if strings.TrimSpace(code) == "" || aiPythonUnsafe.MatchString(code) || strings.Contains(code, "\\x") {
		return false
	}
	for _, m := range aiPythonImport.FindAllStringSubmatch(code, -1) {
		mods := m[1]
		if mods == "" {
			mods = m[2]
		}
		for _, mod := range strings.Split(mods, ",") {
			mod = strings.Fields(mod + " x")[0]
			if !aiPythonSafeModules[strings.Split(mod, ".")[0]] {
				return false
			}
		}
	}
	return !regexp.MustCompile(`\bimport\b`).MatchString(aiPythonImport.ReplaceAllString(code, ""))
}

// aiSystemWritePath matches files whose change alters how the system or a
// login shell behaves: system directories and shell startup files. Writing
// them needs approval in automatic mode, the same as a shell write would.
var aiSystemWritePath = regexp.MustCompile(`(?i)(^/(etc|boot|usr|bin|sbin|lib|lib32|lib64|libx32|var/lib|var/spool|root|dev|proc|sys|run)(/|$)|^/$|` +
	`(^|/)\.(bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zprofile|zshenv|zlogin|zlogout|cshrc|tcshrc|kshrc|mkshrc|inputrc|xprofile|xinitrc|xsession|pam_environment|gitconfig|curlrc|wgetrc|vimrc|tmux\.conf|screenrc)$|` +
	`(^|/)\.config/(fish|autostart|systemd|environment\.d)(/|$)|(^|/)\.local/bin(/|$)|(^|/)\.ssh(/|$))`)

func aiWriteIsSystem(p string) bool {
	p = strings.TrimSpace(strings.ReplaceAll(p, "\\", "/"))
	if p == "" {
		return true
	}
	if strings.HasPrefix(p, "~") {
		if i := strings.IndexByte(p, '/'); i >= 0 {
			p = "/home/user" + p[i:]
		} else {
			return true
		}
	}
	return aiSystemWritePath.MatchString(path.Clean(p))
}
