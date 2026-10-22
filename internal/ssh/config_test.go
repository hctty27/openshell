package sshclient

import (
 "os"
 "path/filepath"
 "strings"
 "testing"
)

func TestOpenSSHConfigHostAliasAndFirstValueWins(t *testing.T) {
 dir := t.TempDir()
 cfg := filepath.Join(dir, "config")
 if err := os.WriteFile(cfg, []byte(`User global
Host prod-*
  HostName %h.internal
  User ops
  Port 2222
  ProxyJump bastion
Host prod-a
  Port 2200
  IdentityFile ~/.ssh/id_ed25519
Host *
  Port 22
`), 0600); err != nil { t.Fatal(err) }
 got, err := readOpenSSHConfig(cfg, "prod-a")
 if err != nil { t.Fatal(err) }
 if got.HostName != "prod-a.internal" || got.User != "global" || got.Port != 2222 || got.ProxyJump != "bastion" || !strings.HasSuffix(filepath.ToSlash(got.IdentityFile), ".ssh/id_ed25519") {
  t.Fatalf("unexpected config: %+v", got)
 }
}

func TestOpenSSHConfigIncludesAndNegation(t *testing.T) {
 dir := t.TempDir()
 if err := os.WriteFile(filepath.Join(dir, "included"), []byte("Host prod-!bad\n  Port 2222\nHost prod-* !prod-bad\n  User deploy\n"), 0600); err != nil { t.Fatal(err) }
 if err := os.WriteFile(filepath.Join(dir, "config"), []byte("Include included\nHost *\n  Port 22\n"), 0600); err != nil { t.Fatal(err) }
 good, err := readOpenSSHConfig(filepath.Join(dir, "config"), "prod-good")
 if err != nil { t.Fatal(err) }
 if good.User != "deploy" || good.Port != 22 { t.Fatalf("unexpected %+v",good) }
 bad, err := readOpenSSHConfig(filepath.Join(dir, "config"), "prod-bad")
 if err != nil { t.Fatal(err) }
 if bad.User != "" { t.Fatalf("negative Host pattern ignored: %+v",bad) }
}

func TestOpenSSHConfigIncludeCycle(t *testing.T) {
 path := filepath.Join(t.TempDir(), "config")
 if err := os.WriteFile(path, []byte("Include config\n"),0600); err != nil { t.Fatal(err) }
 if _, err := readOpenSSHConfig(path, "test"); err == nil { t.Fatal("expected Include cycle rejection") }
}

func TestProxyJumpParsing(t *testing.T) {
 got, err := parseProxyJump("deploy@bastion:2222,root@[::1]:2201", "default")
 if err != nil { t.Fatal(err) }
 if len(got) != 2 || got[0].address != "bastion:2222" || got[0].user != "deploy" || got[1].address != "[::1]:2201" {
  t.Fatalf("unexpected hops: %+v", got)
 }
 for _, spec := range []string{"a,b,c,d","ssh;rm -rf /","a:99999","root@", "host:abc"} {
  if _, err := parseProxyJump(spec,"root"); err == nil { t.Errorf("accepted invalid %q",spec) }
 }
}

func TestApplySSHConfig(t *testing.T) {
 host,user,port,key,jump := ApplySSHConfig("alias","root",22,"","",SSHConfig{HostName:"real.host",User:"admin",Port:2222,IdentityFile:"/tmp/key",ProxyJump:"bastion"})
 if host!="real.host" || user!="admin" || port!=2222 || key!="/tmp/key" || jump!="bastion" { t.Fatal(host,user,port,key,jump) }
}
