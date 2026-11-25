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
	// unverified, dangerous, sensitive or opaque. It is shown to the user.
	Policy string
}

// aiSensitivePath matches credentials and secrets that must not be sent to an
// AI provider without explicit user consent.
var aiSensitivePath = regexp.MustCompile(`(?i)(^|[\s/'"=:~])(` +
	`\.ssh(/|$|\s)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?\b|authorized_keys\b|known_hosts\b|` +
	`etc/(shadow|gshadow|sudoers)\b|etc/sudoers\.d\b|etc/ssh/ssh_host_[\w-]+_key(\s|$|['"])|` +
	`\.npmrc\b|\.pypirc\b|\.config/gh/hosts\.ya?ml\b|\.cargo/credentials(\.toml)?\b|\.terraform\.d/credentials|` +
	`\.aws/|\.azure/|\.config/gcloud\b|\.kube/config\b|\.docker/config\.json\b|` +
	`\.netrc\b|\.pgpass\b|\.my\.cnf\b|\.git-credentials\b|\.gnupg\b|\.password-store\b|\.vault-token\b|` +
	`\.(bash|zsh|mysql|psql|python|node_repl)_history\b|\.env(\.[\w-]+)?(\s|$|['"])|` +
	`proc/[^/\s]+/environ\b|` +
	`etc/wireguard\b|etc/kubernetes/(admin|super-admin|kubelet|controller-manager|scheduler)\.conf\b|etc/kubernetes/pki\b|` +
	`(k3s|rke2)\.yaml\b|rclone\.conf\b|\.s3cfg\b|etc/mysql/debian\.cnf\b|\.htpasswd\b|[\w.-]*\.keytab\b|etc/ppp/(chap|pap)-secrets\b|` +
	`var/log/(auth\.log|secure|btmp)\b|` +
	`169\.254\.169\.254\b|fd00:ec2::254\b|metadata\.google\.internal\b|100\.100\.100\.200\b|` +
	`[^\s/'"]+\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn|tfstate|tfstate\.backup)(\s|$|['"])` +
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
// automatic mode. It looks inside wrappers such as bash -c, sh -c, su -c,
// ssh host CMD and find -exec, and treats find -delete, sed -i, package
// removal and writes into system directories as destructive.
func aiShellDangerous(command string) bool {
	return aiShellDangerousDepth(command, 0)
}

func aiShellDangerousDepth(command string, depth int) bool {
	lower := strings.ToLower(command)
	for _, pattern := range aiDangerousPatterns {
		if pattern.MatchString(lower) {
			return true
		}
	}
	// The naive split also looks at text inside quotes (over-matching only
	// adds a prompt); the quote-aware split keeps script arguments whole.
	segments := append(aiShellSegments(command), aiShellSegmentsQuoted(command)...)
	for _, segment := range segments {
		// aiShellFields removes quotes and backslashes, so \rm, r"m" and
		// 'rm' are all seen as rm.
		words := aiStripCommandPrefixes(aiShellFields(segment))
		if len(words) == 0 {
			continue
		}
		name := strings.ToLower(path.Base(words[0]))
		args := strings.ToLower(strings.Join(words[1:], " "))
		switch name {
		case "rm", "rmdir", "shred", "wipefs", "fdisk", "sfdisk", "parted", "sgdisk", "dd",
			"shutdown", "reboot", "halt", "poweroff", "init", "telinit",
			"kill", "killall", "pkill", "userdel", "usermod", "groupdel", "passwd", "chpasswd",
			"iptables", "ip6tables", "nft", "ufw", "firewall-cmd", "truncate", "mkswap", "swapoff",
			"umount", "crontab", "visudo", "chattr", "unlink", "srm", "blkdiscard", "losetup", "lvremove", "vgremove", "pvremove", "zpool", "zfs":
			if name == "crontab" && !strings.Contains(" "+args+" ", " -r") && !strings.Contains(" "+args+" ", " -e") {
				continue
			}
			if (name == "zfs" || name == "zpool") && !regexp.MustCompile(`\b(destroy|rollback|export|offline|detach|remove|labelclear)\b`).MatchString(args) {
				continue
			}
			return true
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
			if regexp.MustCompile(`(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*(--force|-f\b)|branch\s+-d|checkout\s+(--\s|\.)|restore\b|stash\s+(drop|clear))`).MatchString(args) {
				return true
			}
		}
		if strings.HasPrefix(name, "mkfs") {
			return true
		}
		if aiShellArgDangerous(name, words[1:]) || aiShellNestedDangerous(name, words[1:], depth) {
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

// aiShellReadOnlyCommands are the only programs that may run without
// approval, in both modes (see aiShellReadOnly for the argument checks).
// Anything outside this list, or using shell features such as redirection,
// command substitution or chaining, requires approval.
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
	"uniq": true, "diff": true, "cmp": true, "comm": true, "strings": true, "groups": true, "arch": true,
	"sha512sum": true, "cksum": true, "lsb_release": true, "pgrep": true, "lsusb": true, "lspci": true,
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
		// System directories and shell startup files are always protected.
		// Ordinary project/application files are risk-assessed by the model
		// in review mode instead of prompting for every single write.
		if aiWriteIsSystem(filePath) {
			return aiApprovalPolicy{true, "write"}
		}
		if review && modelAsked {
			return aiApprovalPolicy{true, "model"}
		}
		return aiApprovalPolicy{}
	case "ssh_exec":
		switch program {
		case "python":
			// Pure computation over in-memory values is safe in either mode.
			// File, process, network, dynamic-code and unknown-module access
			// cannot be proven harmless and always needs approval.
			if !aiPythonSafe(command) {
				return aiApprovalPolicy{true, "python"}
			}
			if review && modelAsked {
				return aiApprovalPolicy{true, "model"}
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
		if aiShellSensitive(command) {
			return aiApprovalPolicy{true, "sensitive"}
		}
		if aiShellOpaque(command) || strings.ContainsAny(command, "$`") {
			// The program or a path is computed at run time ($(...), $VAR,
			// eval), so none of the checks above can be trusted.
			return aiApprovalPolicy{true, "opaque"}
		}
		if review && modelAsked {
			return aiApprovalPolicy{true, "model"}
		}
		// Keep shell execution conservative: only commands that parse cleanly
		// and are known to be read-only run without approval in either mode.
		if !aiShellReadOnly(command) || aiShellFileAccessNeedsApproval(command) {
			return aiApprovalPolicy{true, "unverified"}
		}
		return aiApprovalPolicy{}
	}
	return aiApprovalPolicy{}
}
