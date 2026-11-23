package main

import (
	"path"
	"regexp"
	"strings"
)

// aiShellFields splits one shell segment into words the way the shell would
// see them after quote removal: 'single', "double" and \escaped characters
// are joined into one word without the quoting characters. It is used to see
// through tricks such as \rm, r"m" or bash -c 'rm -rf /'. An unclosed quote
// runs to the end of the input.
func aiShellFields(s string) []string {
	var words []string
	var cur strings.Builder
	inWord := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\\' && i+1 < len(s):
			i++
			cur.WriteByte(s[i])
			inWord = true
		case c == '\'':
			inWord = true
			for i++; i < len(s) && s[i] != '\''; i++ {
				cur.WriteByte(s[i])
			}
		case c == '"':
			inWord = true
			for i++; i < len(s) && s[i] != '"'; i++ {
				if s[i] == '\\' && i+1 < len(s) && strings.ContainsRune("\"\\$`", rune(s[i+1])) {
					i++
				}
				cur.WriteByte(s[i])
			}
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			if inWord {
				words = append(words, cur.String())
				cur.Reset()
				inWord = false
			}
		default:
			cur.WriteByte(c)
			inWord = true
		}
	}
	if inWord {
		words = append(words, cur.String())
	}
	return words
}

// aiShellOpaqueCommand matches a command whose program name is computed at
// run time (variable, command substitution or eval), so OpenShell cannot tell
// what it will run.
var aiShellOpaqueCommand = regexp.MustCompile(`(^|[;&|(\n{]|\b(then|do|else)\b)\s*((sudo|doas|command|builtin|exec|env|nohup|xargs)\s+(-\S+\s+)*)*["']?(\$|` + "`" + `)`)

// aiShellOpaque reports commands that run a program OpenShell cannot name.
func aiShellOpaque(command string) bool {
	if aiShellOpaqueCommand.MatchString(command) {
		return true
	}
	for _, segment := range aiShellSegments(command) {
		words := aiStripCommandPrefixes(aiShellFields(segment))
		if len(words) > 0 && (words[0] == "eval" || words[0] == "source" || words[0] == ".") {
			return true
		}
	}
	return false
}

var aiShellInterpreters = map[string]bool{
	"sh": true, "bash": true, "zsh": true, "dash": true, "ksh": true, "ash": true, "fish": true, "busybox": true,
}

var aiScriptDestructive = regexp.MustCompile(`(?i)(rmtree|os\.remove|os\.unlink|\bunlink\s*\(|os\.system|subprocess|popen|\bexec\s*\(|\bsystem\s*\(|child_process|fs\.(rm|unlink|rmdir)|file\.delete|\brm\s+-)`)

var aiPackageRemoval = regexp.MustCompile(`^(remove|purge|autoremove|erase|del|delete|uninstall|rm|-r[a-z]*|-x)$`)

// aiSystemPath matches arguments that point into the operating system.
var aiSystemPath = regexp.MustCompile(`^/(etc|boot|usr|bin|sbin|lib|lib32|lib64|libx32|var/lib|root|dev|proc|sys)?(/|$)`)

// aiShellNestedDangerous checks commands that run another command: shell -c
// strings, find -exec, ssh remote commands, su -c and script one-liners.
func aiShellNestedDangerous(name string, args []string, depth int) bool {
	if depth > 4 {
		return true
	}
	switch {
	case aiShellInterpreters[name]:
		for i, a := range args {
			if (a == "-c" || (strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && strings.Contains(a, "c"))) && i+1 < len(args) {
				return aiShellDangerousDepth(args[i+1], depth+1)
			}
		}
		// "bash script.sh", "sh -s < x" or a piped script: unknown contents.
		return false
	case name == "su" || name == "runuser":
		for i, a := range args {
			if (a == "-c" || a == "--command") && i+1 < len(args) {
				return aiShellDangerousDepth(args[i+1], depth+1)
			}
		}
	case name == "ssh":
		rest := aiSSHRemoteCommand(args)
		if rest != "" {
			return aiShellDangerousDepth(rest, depth+1)
		}
	case name == "find":
		for i := 0; i < len(args); i++ {
			switch args[i] {
			case "-delete":
				return true
			case "-exec", "-execdir", "-ok", "-okdir":
				var inner []string
				for i++; i < len(args) && args[i] != ";" && args[i] != "+"; i++ {
					inner = append(inner, args[i])
				}
				if aiShellDangerousDepth(strings.Join(aiQuoteWords(inner), " "), depth+1) {
					return true
				}
			}
		}
	case name == "python" || name == "python2" || name == "python3" || name == "perl" || name == "ruby" || name == "node" || name == "php":
		for i, a := range args {
			if (a == "-c" || a == "-e" || a == "-E" || a == "-r") && i+1 < len(args) && aiScriptDestructive.MatchString(args[i+1]) {
				return true
			}
			if name == "perl" && strings.HasPrefix(a, "-") && strings.Contains(a, "i") && !strings.HasPrefix(a, "--") {
				return true // perl -i edits files in place
			}
		}
	}
	return false
}

// aiSSHRemoteCommand returns the command an ssh invocation runs remotely.
func aiSSHRemoteCommand(args []string) string {
	withValue := "bcDEeFIiJLlmOoPpQRSWw"
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "-") && len(a) > 1 {
			last := a[len(a)-1:]
			if len(a) == 2 && strings.Contains(withValue, last) {
				i++
			}
			continue
		}
		// a is the destination. ssh joins the rest with spaces and the
		// remote shell parses it again, so the quoting is not kept.
		return strings.Join(args[i+1:], " ")
	}
	return ""
}

// aiQuoteWords re-quotes words that contain spaces so a nested command
// string keeps its word boundaries.
func aiQuoteWords(words []string) []string {
	out := make([]string, len(words))
	for i, w := range words {
		if strings.ContainsAny(w, " \t") {
			out[i] = "'" + strings.ReplaceAll(w, "'", "") + "'"
		} else {
			out[i] = w
		}
	}
	return out
}

// aiShellArgDangerous covers commands that are harmless in general but
// destructive with certain arguments.
func aiShellArgDangerous(name string, args []string) bool {
	switch name {
	case "sed":
		for _, a := range args {
			if a == "--in-place" || strings.HasPrefix(a, "--in-place=") || (strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && strings.Contains(a, "i")) {
				return true
			}
		}
	case "mv":
		for _, a := range args {
			if !strings.HasPrefix(a, "-") && aiSystemPath.MatchString(path.Clean(a)) {
				return true
			}
		}
	case "cp", "install", "ln", "rsync", "tee", "tar", "unzip":
		// Overwriting files that belong to the operating system.
		for i, a := range args {
			if strings.HasPrefix(a, "-") {
				if (a == "-t" || a == "-C" || a == "-d") && i+1 < len(args) && aiSystemPath.MatchString(path.Clean(args[i+1])) {
					return true
				}
				if strings.HasPrefix(a, "--target-directory=") || strings.HasPrefix(a, "--directory=") {
					if aiSystemPath.MatchString(path.Clean(a[strings.Index(a, "=")+1:])) {
						return true
					}
				}
				continue
			}
			if (name == "tee" || i == len(args)-1) && name != "tar" && name != "unzip" && aiSystemPath.MatchString(path.Clean(a)) {
				return true
			}
		}
	case "chmod", "chown", "chgrp", "setfacl":
		for _, a := range args {
			if a == "-R" || a == "-r" || a == "--recursive" || (strings.HasPrefix(a, "-") && strings.Contains(a, "R")) {
				return true
			}
			if !strings.HasPrefix(a, "-") && strings.HasPrefix(a, "/") && aiSystemPath.MatchString(path.Clean(a)) {
				return true
			}
		}
	case "apt", "apt-get", "aptitude", "yum", "dnf", "zypper", "apk", "snap", "pip", "pip3", "npm", "pnpm", "yarn", "gem", "brew", "flatpak":
		for _, a := range args {
			if aiPackageRemoval.MatchString(a) && (a != "-x" || name == "zypper") {
				return true
			}
		}
	case "nc", "ncat", "netcat", "socat":
		// Remote shells: nc -e /bin/sh, socat EXEC:...
		for _, a := range args {
			if a == "-e" || a == "-c" || a == "--exec" || a == "--sh-exec" || strings.HasPrefix(strings.ToLower(a), "exec:") || strings.HasPrefix(strings.ToLower(a), "system:") {
				return true
			}
		}
	case "pacman":
		for _, a := range args {
			if strings.HasPrefix(a, "-R") || a == "--remove" {
				return true
			}
		}
	case "rpm", "dpkg":
		for _, a := range args {
			if a == "-e" || a == "--erase" || a == "-r" || a == "-P" || a == "--remove" || a == "--purge" {
				return true
			}
		}
	}
	return false
}

// aiShellExposesSecrets reports commands that print credentials or the whole
// environment (which often holds tokens) and would send them to the AI
// provider.
func aiShellExposesSecrets(command string) bool {
	for _, segment := range aiShellSegments(command) {
		raw := aiShellFields(segment)
		if len(raw) == 0 {
			continue
		}
		name := path.Base(raw[0])
		if name == "sudo" || name == "doas" {
			raw = raw[1:]
			for len(raw) > 0 && strings.HasPrefix(raw[0], "-") {
				raw = raw[1:]
			}
			if len(raw) == 0 {
				continue
			}
			name = path.Base(raw[0])
		}
		args := raw[1:]
		switch name {
		case "env":
			onlyFlags := true
			for _, a := range args {
				if !strings.HasPrefix(a, "-") {
					onlyFlags = false
				}
			}
			if onlyFlags {
				return true
			}
		case "printenv", "set", "declare", "typeset", "export", "compgen":
			if name == "export" || name == "declare" || name == "typeset" {
				if len(args) == 0 || (len(args) == 1 && (args[0] == "-p" || args[0] == "-x" || args[0] == "-px")) {
					return true
				}
				continue
			}
			if name == "set" && len(args) > 0 {
				continue
			}
			if name == "compgen" && !(len(args) > 0 && (args[0] == "-v" || args[0] == "-e")) {
				continue
			}
			return true
		case "kubectl", "oc":
			joined := " " + strings.Join(args, " ") + " "
			if regexp.MustCompile(`\s(get|describe|edit)\s.*\bsecrets?\b|\ssecrets?/`).MatchString(joined) ||
				regexp.MustCompile(`\screate\s+token\b|\sconfig\s+view\s.*--raw`).MatchString(joined) {
				return true
			}
		case "docker", "podman":
			if len(args) > 0 && (args[0] == "inspect" || (args[0] == "secret" && len(args) > 1 && args[1] == "inspect")) {
				// docker inspect shows container environment variables.
				return true
			}
		case "aws":
			if regexp.MustCompile(`\b(secretsmanager\s+get-secret-value|ssm\s+get-parameters?\b.*--with-decryption|configure\s+(get|export-credentials)|sts\s+get-session-token)`).MatchString(strings.Join(args, " ")) {
				return true
			}
		case "vault":
			if len(args) > 0 && (args[0] == "read" || args[0] == "kv" || args[0] == "print") {
				return true
			}
		case "gh":
			if len(args) > 1 && args[0] == "auth" && (args[1] == "token" || args[1] == "status") {
				return true
			}
		}
	}
	return false
}

// aiSensitiveGlobSamples are concrete files that aiSensitivePath protects.
// A glob, brace or variable expansion that could expand to one of them needs
// approval, because the shell, not OpenShell, decides what is read.
var aiSensitiveGlobSamples = []string{
	"/etc/shadow", "/etc/shadow-", "/etc/gshadow", "/etc/gshadow-", "/etc/sudoers", "/etc/sudoers.d/90-cloud-init-users",
	"/etc/ssh/ssh_host_rsa_key", "/etc/ssh/ssh_host_ecdsa_key", "/etc/ssh/ssh_host_ed25519_key",
	"/etc/ssl/private/server.key", "/etc/letsencrypt/live/example.com/privkey.pem",
	"/proc/self/environ", "/proc/1/environ",
	"/srv/app/.env", "/srv/app/.env.production", "/srv/app/server.pem", "/srv/app/server.key",
}

var aiSensitiveHomeSamples = []string{
	".ssh/id_rsa", ".ssh/id_dsa", ".ssh/id_ecdsa", ".ssh/id_ed25519", ".ssh/authorized_keys", ".ssh/known_hosts", ".ssh/config",
	".aws/credentials", ".aws/config", ".azure/accessTokens.json", ".config/gcloud/credentials.db", ".kube/config",
	".docker/config.json", ".netrc", ".pgpass", ".my.cnf", ".git-credentials", ".gnupg/private-keys-v1.d/x.key",
	".password-store/x.gpg", ".vault-token", ".npmrc", ".pypirc", ".config/gh/hosts.yml", ".cargo/credentials.toml",
	".bash_history", ".zsh_history", ".mysql_history", ".psql_history", ".python_history", ".env",
}

var aiGlobSamples = func() []string {
	out := append([]string{}, aiSensitiveGlobSamples...)
	for _, home := range []string{"/root/", "/home/user/"} {
		for _, f := range aiSensitiveHomeSamples {
			out = append(out, home+f)
		}
	}
	return out
}()

// aiGlobRegexp converts one shell word with glob, brace or variable syntax to
// a regular expression over paths. ok is false when the word has no
// expansion at all.
func aiGlobRegexp(word string) (*regexp.Regexp, bool) {
	var b strings.Builder
	expands := false
	braceDepth := 0
	// The shell does not let *, ? or [..] match a leading dot.
	componentStart := func(i int) bool { return i == 0 || word[i-1] == '/' }
	if strings.HasPrefix(word, "~") {
		end := strings.Index(word, "/")
		if end < 0 {
			end = len(word)
		}
		b.WriteString(`/(root|home/[^/]+)`)
		word = word[end:]
		expands = true
	}
	for i := 0; i < len(word); i++ {
		c := word[i]
		switch c {
		case '*':
			expands = true
			if componentStart(i) {
				b.WriteString(`([^./][^/]*)?`)
			} else {
				b.WriteString(`[^/]*`)
			}
		case '?':
			expands = true
			if componentStart(i) {
				b.WriteString(`[^./]`)
			} else {
				b.WriteString(`[^/]`)
			}
		case '[':
			end := strings.IndexByte(word[i+1:], ']')
			if end < 0 {
				b.WriteString(`\[`)
				continue
			}
			class := word[i+1 : i+1+end]
			if class == "" {
				b.WriteString(`\[`)
				continue
			}
			expands = true
			if class[0] == '!' {
				class = "^" + class[1:]
			}
			b.WriteString("[" + strings.ReplaceAll(class, `\`, `\\`) + "]")
			i += end + 1
		case '{':
			expands = true
			braceDepth++
			b.WriteString("(")
		case ',':
			if braceDepth > 0 {
				b.WriteString("|")
			} else {
				b.WriteString(",")
			}
		case '}':
			if braceDepth > 0 {
				braceDepth--
				b.WriteString(")")
			} else {
				b.WriteString(`\}`)
			}
		case '$':
			// $VAR, ${VAR}, $(cmd): anything, possibly with slashes.
			expands = true
			j := i + 1
			switch {
			case j < len(word) && word[j] == '{':
				if k := strings.IndexByte(word[j:], '}'); k >= 0 {
					j += k + 1
				} else {
					j = len(word)
				}
			case j < len(word) && word[j] == '(':
				j = len(word)
			default:
				for j < len(word) && (word[j] == '_' || (word[j] >= 'a' && word[j] <= 'z') || (word[j] >= 'A' && word[j] <= 'Z') || (word[j] >= '0' && word[j] <= '9')) {
					j++
				}
			}
			name := strings.Trim(word[i+1:j], "{}")
			if name == "HOME" && i == 0 {
				b.WriteString(`/(root|home/[^/]+)`)
			} else {
				b.WriteString(`.*`)
			}
			i = j - 1
		case '`':
			expands = true
			b.WriteString(`.*`)
			if k := strings.IndexByte(word[i+1:], '`'); k >= 0 {
				i += k + 1
			} else {
				i = len(word)
			}
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	for ; braceDepth > 0; braceDepth-- {
		b.WriteString(")")
	}
	if !expands {
		return nil, false
	}
	pattern := b.String()
	if !strings.HasPrefix(pattern, "/") {
		// Relative patterns may be evaluated in any directory.
		pattern = `(^|.*/)` + pattern
	}
	re, err := regexp.Compile("(?i)^" + pattern + "$")
	if err != nil {
		return nil, true
	}
	return re, true
}

var aiBareExpansion = regexp.MustCompile(`^(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$\{?[0-9#?@*!$-]\}?|\$\(.*|` + "`" + `.*)$`)

// aiShellGlobSensitive reports whether any word of the command could be
// expanded by the shell into a sensitive path, for example cat /etc/sh*,
// cat ~/.s*/id_* or cat /etc/{shadow,hosts}.
func aiShellGlobSensitive(command string) bool {
	for _, segment := range aiShellSegments(command) {
		for _, word := range strings.Fields(segment) {
			word = strings.Trim(word, `'"`)
			if word == "" || strings.HasPrefix(word, "-") && !strings.Contains(word, "=") {
				continue
			}
			if i := strings.Index(word, "="); i >= 0 && strings.HasPrefix(word, "-") {
				word = word[i+1:] // --file=/etc/sh*
			}
			if !strings.ContainsAny(word, "*?[{$`~") {
				continue
			}
			// A bare variable such as $PATH, $1 or a whole $(...) substitution
			// is not a path pattern; the substituted command is checked on its
			// own segment.
			if aiBareExpansion.MatchString(word) {
				continue
			}
			// "cat *" or "grep x */*" has no fixed part to aim at a secret;
			// prompting for every bare wildcard would make automatic mode
			// useless.
			if !strings.HasPrefix(word, "~") && !regexp.MustCompile(`[A-Za-z0-9_.]`).MatchString(regexp.MustCompile(`\$\{?[A-Za-z_][A-Za-z0-9_]*\}?`).ReplaceAllString(word, "")) {
				continue
			}
			re, expands := aiGlobRegexp(word)
			if !expands {
				continue
			}
			if re == nil {
				return true // cannot parse it, fail closed
			}
			for _, sample := range aiGlobSamples {
				if re.MatchString(sample) {
					return true
				}
			}
		}
	}
	return false
}

// aiShellSegmentsQuoted splits on control operators outside quotes, so a
// quoted script such as python3 -c 'import os; os.system("rm -rf /")' stays
// one argument.
func aiShellSegmentsQuoted(command string) []string {
	var out []string
	start := 0
	var quote byte
	for i := 0; i < len(command); i++ {
		c := command[i]
		switch {
		case quote != 0:
			if c == '\\' && quote == '"' {
				i++
			} else if c == quote {
				quote = 0
			}
		case c == '\\':
			i++
		case c == '\'' || c == '"':
			quote = c
		case strings.IndexByte(";|&\n\r()`", c) >= 0:
			out = append(out, command[start:i])
			start = i + 1
		}
	}
	return append(out, command[start:])
}
