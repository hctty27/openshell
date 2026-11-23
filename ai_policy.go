package main

import (
	"path"
	"regexp"
	"strings"
)

// aiApprovalPolicy is decided by OpenShell, never by the model. The model's
// needs_confirmation flag can only add an approval step; it can never remove
// one that this policy requires.
type aiApprovalPolicy struct {
	Required bool
	// Policy explains why approval is needed: model, write, python,
	// unverified, dangerous or sensitive. It is shown to the user.
	Policy string
}

// aiSensitivePath matches credentials and secrets that must not be sent to an
// AI provider without explicit user consent.
var aiSensitivePath = regexp.MustCompile(`(?i)(^|[\s/'"=:~])(` +
	`\.ssh(/|$|\s)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?\b|authorized_keys\b|known_hosts\b|` +
	`etc/(shadow|gshadow|sudoers)\b|etc/sudoers\.d\b|` +
	`\.aws/|\.azure/|\.config/gcloud\b|\.kube/config\b|\.docker/config\.json\b|` +
	`\.netrc\b|\.pgpass\b|\.my\.cnf\b|\.git-credentials\b|\.gnupg\b|\.password-store\b|\.vault-token\b|` +
	`\.(bash|zsh|mysql|psql|python|node_repl)_history\b|\.env(\.[\w-]+)?(\s|$|['"])|` +
	`proc/[^/\s]+/environ\b|` +
	`[^\s/'"]+\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn)(\s|$|['"])` +
	`)`)

func aiPathIsSensitive(p string) bool {
	p = strings.TrimSpace(p)
	if p == "" {
		return false
	}
	clean := path.Clean(strings.ReplaceAll(p, "\\", "/"))
	return aiSensitivePath.MatchString(" "+clean+" ") || aiSensitivePath.MatchString(" "+p+" ")
}

// aiShellDangerous returns true for commands that can destroy data, stop
// services or execute downloaded code. They always need approval, even in
// automatic mode.
func aiShellDangerous(command string) bool {
	lower := strings.ToLower(command)
	for _, pattern := range aiDangerousPatterns {
		if pattern.MatchString(lower) {
			return true
		}
	}
	for _, segment := range aiShellSegments(lower) {
		words := aiStripCommandPrefixes(strings.Fields(segment))
		if len(words) == 0 {
			continue
		}
		name := path.Base(words[0])
		args := strings.Join(words[1:], " ")
		switch name {
		case "rm", "rmdir", "shred", "wipefs", "fdisk", "sfdisk", "parted", "sgdisk", "dd",
			"shutdown", "reboot", "halt", "poweroff", "init", "telinit",
			"kill", "killall", "pkill", "userdel", "usermod", "groupdel", "passwd", "chpasswd",
			"iptables", "ip6tables", "nft", "ufw", "firewall-cmd", "truncate", "mkswap", "swapoff",
			"umount", "crontab", "visudo", "chattr":
			if name == "crontab" && !strings.Contains(" "+args+" ", " -r") && !strings.Contains(" "+args+" ", " -e") {
				continue
			}
			return true
		case "chmod", "chown", "chgrp":
			if strings.Contains(" "+args, " -r") || strings.Contains(args, "--recursive") || strings.Contains(" "+args+" ", " / ") {
				return true
			}
		case "systemctl", "service":
			if regexp.MustCompile(`\b(start|stop|restart|reload|try-restart|reload-or-restart|disable|enable|mask|kill|isolate|poweroff|reboot|halt|daemon-reload|set-default)\b`).MatchString(args) {
				return true
			}
		case "docker", "podman", "nerdctl":
			if regexp.MustCompile(`\b(rm|rmi|kill|stop|restart|prune|down)\b`).MatchString(args) {
				return true
			}
		case "kubectl", "oc":
			if regexp.MustCompile(`\b(delete|drain|cordon|scale|rollout\s+restart|replace|apply|patch|edit)\b`).MatchString(args) {
				return true
			}
		case "git":
			if regexp.MustCompile(`(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*(--force|-f\b)|branch\s+-d)`).MatchString(args) {
				return true
			}
		}
		if strings.HasPrefix(name, "mkfs") {
			return true
		}
	}
	return false
}

var aiDangerousPatterns = []*regexp.Regexp{
	regexp.MustCompile(`:\(\)\s*\{`),                                          // fork bomb
	regexp.MustCompile(`(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b`), // pipe download to shell
	regexp.MustCompile(`>\s*/dev/(sd|nvme|vd|xvd|hd|mmcblk)`),
	regexp.MustCompile(`\bof=/dev/`),
	regexp.MustCompile(`>\s*/(etc|boot|usr|bin|sbin|lib)/`),
	regexp.MustCompile(`\b(drop|truncate)\s+(table|database|schema)\b`),
	regexp.MustCompile(`\bflushall\b|\bflushdb\b`),
}

// aiShellSegments splits on shell control operators. It is only used to find
// command names, so quoting does not need to be perfect: over-matching only
// leads to an extra approval prompt.
func aiShellSegments(command string) []string {
	return regexp.MustCompile(`\|\||&&|[;|&\n\r` + "`" + `]|\$\(|\(|\)`).Split(command, -1)
}

func aiStripCommandPrefixes(words []string) []string {
	for len(words) > 0 {
		switch path.Base(words[0]) {
		case "sudo", "doas", "nohup", "time", "nice", "ionice", "exec", "command", "builtin", "xargs", "env", "timeout", "stdbuf", "busybox", "watch":
			words = words[1:]
			for len(words) > 0 && (strings.HasPrefix(words[0], "-") || strings.Contains(words[0], "=") || aiLooksNumeric(words[0])) {
				words = words[1:]
			}
		default:
			if strings.Contains(words[0], "=") && !strings.HasPrefix(words[0], "=") {
				words = words[1:] // VAR=value prefix
				continue
			}
			return words
		}
	}
	return words
}

func aiLooksNumeric(s string) bool {
	s = strings.TrimRight(s, "smhd")
	if s == "" {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && c != '.' {
			return false
		}
	}
	return true
}

// aiShellReadOnlyCommands may run without approval in review mode. Anything
// outside this list, or using shell features such as redirection, command
// substitution or chaining, requires approval.
var aiShellReadOnlyCommands = map[string]bool{
	"ls": true, "pwd": true, "whoami": true, "id": true, "hostname": true, "uname": true,
	"uptime": true, "date": true, "df": true, "du": true, "free": true, "ps": true,
	"cat": true, "head": true, "tail": true, "wc": true, "grep": true, "egrep": true, "fgrep": true,
	"find": true, "stat": true, "file": true, "which": true, "type": true, "echo": true,
	"ss": true, "netstat": true, "lsblk": true, "lscpu": true, "lsof": true, "nproc": true,
	"systemctl": true, "journalctl": true, "docker": true, "kubectl": true, "git": true,
	"sort": true, "cut": true, "tr": true, "readlink": true, "realpath": true, "basename": true,
	"dirname": true, "sha256sum": true, "sha1sum": true, "md5sum": true, "tree": true, "w": true,
	"who": true, "last": true, "dmesg": true, "getent": true, "true": true,
	"column": true, "nl": true, "ip": true, "vmstat": true, "iostat": true, "mpstat": true,
	"lsmod": true, "locale": true, "timedatectl": true, "hostnamectl": true, "test": true,
}

func aiShellReadOnly(command string) bool {
	trimmed := strings.TrimSpace(command)
	// Discarding stderr is harmless; every other redirection needs approval.
	trimmed = strings.ReplaceAll(trimmed, "2>/dev/null", " ")
	trimmed = strings.ReplaceAll(trimmed, "2>&1", " ")
	if trimmed == "" || strings.ContainsAny(trimmed, ";&$`<>(){}\n\r\\!") {
		return false
	}
	for _, segment := range strings.Split(trimmed, "|") {
		words := strings.Fields(segment)
		if len(words) == 0 || !aiShellReadOnlyCommands[words[0]] {
			return false
		}
		args := " " + strings.Join(words[1:], " ") + " "
		sub := ""
		if len(words) > 1 {
			sub = words[1]
		}
		switch words[0] {
		case "tail", "journalctl":
			if strings.Contains(args, " -f") || strings.Contains(args, "--follow") || strings.Contains(args, " -F") ||
				strings.Contains(args, "--vacuum") || strings.Contains(args, "--rotate") || strings.Contains(args, "--flush") {
				return false
			}
		case "find":
			for _, flag := range []string{" -exec", " -ok", " -delete", " -fprint", " -fls"} {
				if strings.Contains(args, flag) {
					return false
				}
			}
		case "sort":
			if strings.Contains(args, " -o") || strings.Contains(args, "--output") {
				return false
			}
		case "dmesg":
			if strings.Contains(args, " -c") || strings.Contains(args, " -C") || strings.Contains(args, "--clear") {
				return false
			}
		case "date", "hostname", "timedatectl", "hostnamectl":
			if strings.TrimSpace(args) != "" && !strings.HasPrefix(strings.TrimSpace(args), "+") && sub != "status" && sub != "-I" && sub != "-f" && sub != "-i" && sub != "-s" {
				return false
			}
		case "systemctl":
			if !map[string]bool{"status": true, "list-units": true, "list-unit-files": true, "is-active": true, "is-enabled": true, "is-failed": true, "show": true, "cat": true, "list-timers": true, "--failed": true}[sub] {
				return false
			}
		case "docker":
			if !map[string]bool{"ps": true, "images": true, "inspect": true, "logs": true, "version": true, "info": true, "stats": true}[sub] ||
				(sub == "logs" && (strings.Contains(args, " -f") || strings.Contains(args, "--follow"))) ||
				(sub == "stats" && !strings.Contains(args, "--no-stream")) {
				return false
			}
		case "kubectl":
			if !map[string]bool{"get": true, "describe": true, "logs": true, "version": true, "top": true, "explain": true, "api-resources": true}[sub] ||
				strings.Contains(args, " -f") || strings.Contains(args, "--follow") || strings.Contains(args, " -w") || strings.Contains(args, "--watch") {
				return false
			}
			if sub == "get" && regexp.MustCompile(`\bsecrets?\b`).MatchString(args) {
				return false
			}
		case "git":
			if !map[string]bool{"status": true, "log": true, "diff": true, "show": true, "rev-parse": true, "remote": true, "branch": true, "describe": true}[sub] ||
				(sub == "branch" && len(words) > 2 && words[2] != "-a" && words[2] != "-r" && words[2] != "--list" && words[2] != "-v" && words[2] != "-vv") ||
				(sub == "remote" && len(words) > 2 && words[2] != "-v") {
				return false
			}
		case "ip":
			if len(words) < 2 || !map[string]bool{"a": true, "addr": true, "address": true, "r": true, "route": true, "link": true, "l": true, "-br": true, "-s": true, "neigh": true, "-4": true, "-6": true}[sub] ||
				regexp.MustCompile(`\b(add|del|delete|set|flush|change|replace|append)\b`).MatchString(args) {
				return false
			}
		}
	}
	return true
}

// aiToolApproval decides whether a tool call must be approved by the user.
// program is the interactive client of the visible terminal ("shell",
// "mysql", "psql", "redis", "python") or "" for an independent SSH channel.
func aiToolApproval(mode, tool, program, command, filePath string, modelAsked bool) aiApprovalPolicy {
	review := mode != "auto"
	switch tool {
	case "sftp_list", "sftp_read":
		if aiPathIsSensitive(filePath) {
			return aiApprovalPolicy{true, "sensitive"}
		}
		return aiApprovalPolicy{}
	case "sftp_write":
		if aiPathIsSensitive(filePath) {
			return aiApprovalPolicy{true, "sensitive"}
		}
		if review {
			return aiApprovalPolicy{true, "write"}
		}
		return aiApprovalPolicy{}
	case "ssh_exec":
		switch program {
		case "python":
			if review {
				return aiApprovalPolicy{true, "python"}
			}
			return aiApprovalPolicy{}
		case "mysql", "psql", "redis":
			// The statement is restricted to validated read-only queries by
			// the terminal client before it is sent.
			if aiShellDangerous(command) {
				return aiApprovalPolicy{true, "dangerous"}
			}
			if review && modelAsked {
				return aiApprovalPolicy{true, "model"}
			}
			return aiApprovalPolicy{}
		}
		if aiShellDangerous(command) {
			return aiApprovalPolicy{true, "dangerous"}
		}
		if aiPathIsSensitive(command) {
			return aiApprovalPolicy{true, "sensitive"}
		}
		if review && modelAsked {
			return aiApprovalPolicy{true, "model"}
		}
		if review && !aiShellReadOnly(command) {
			return aiApprovalPolicy{true, "unverified"}
		}
		return aiApprovalPolicy{}
	}
	return aiApprovalPolicy{}
}
