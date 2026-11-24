package main

import "testing"

func TestAIShellUnverifiedFileAccessAlwaysAsks(t *testing.T){
	for _,mode:=range []string{"auto","review"}{
		for _,cmd:=range []string{
			"cat /tmp/report","cat report","cat *.txt","head -n 1 /tmp/report",
			"tail -20 logs/current","grep needle /tmp/report","grep -r needle .",
			"ps aux | grep -f /tmp/patterns","ps aux | grep needle /tmp/report",
			"echo x | head /tmp/report","sort --files0-from=/tmp/list",
			"sha256sum /tmp/report","file -f /tmp/list","date --file=/tmp/dates",
			"find -files0-from /tmp/list","journalctl --file=/tmp/log",
			"git diff --no-ext-diff --no-textconv --no-index a b",
		}{
			for _,program:=range []string{"","shell"}{
				if got:=aiToolApproval(mode,"ssh_exec",program,cmd,"",false);!got.Required{t.Errorf("%s/%s bypass: %q",mode,program,cmd)}
			}
		}
		for _,cmd:=range []string{"df -h","free -m","ls -la","ps aux | grep nginx | head -20","ps aux | grep -i nginx | head -n 5","docker ps","journalctl -u nginx -n 50 --no-pager","git status"}{
			if got:=aiToolApproval(mode,"ssh_exec","",cmd,"",false);got.Required{t.Errorf("%s ordinary inspection %q: %+v",mode,cmd,got)}
		}
	}
}
