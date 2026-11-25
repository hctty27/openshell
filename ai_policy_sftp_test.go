package main

import "testing"

func TestAISFTPPolicyUsesCanonicalTarget(t *testing.T) {
    for _, tc := range []struct{
        mode, tool, source, resolved, policy string
        link, required bool
    }{
        {"auto", "sftp_read", "/tmp/alias", "/etc/shadow", "sensitive", true, true},
        {"auto", "sftp_list", "/tmp/dir", "/root/.ssh", "sensitive", true, true},
        {"auto", "sftp_write", "/srv/current", "/etc/cron.d/job", "write", true, true},
        {"auto", "sftp_read", "/tmp/link", "/tmp/innocent.txt", "unverified", true, true},
        {"auto", "sftp_read", "/srv/a.txt", "/srv/a.txt", "", false, false},
        {"auto", "sftp_write", "/srv/a.txt", "/srv/a.txt", "", false, false},
        {"review", "sftp_write", "/srv/a.txt", "/srv/a.txt", "", false, false},
        {"review", "sftp_write", "/tmp/link", "/srv/a.txt", "unverified", true, true},
        {"review", "sftp_write", "/tmp/link", "/etc/ssh/sshd_config", "write", true, true},
        {"auto", "sftp_read", "/etc/shadow", "/tmp/shadow", "sensitive", true, true},
        {"review", "sftp_read", "/tmp/alias", "/tmp/innocent.txt", "unverified", true, true},
    } {
        got:=aiSFTPApprovalPolicy(tc.mode,tc.tool,tc.source,tc.resolved,tc.link,false)
        if got.Required!=tc.required || got.Policy!=tc.policy {
            t.Errorf("%s %s %q=>%q: got %+v, want required=%t policy=%q",
                tc.mode,tc.tool,tc.source,tc.resolved,got,tc.required,tc.policy)
        }
    }
}
