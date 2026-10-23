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

func TestNestedIncludeResolvesRelativeToSSHConfigDirectory(t *testing.T) {
 dir := t.TempDir()
 if err := os.MkdirAll(filepath.Join(dir, "extra"), 0700); err != nil { t.Fatal(err) }
 files := map[string]string{
  "config": "Include extra/first.conf\n",
  "extra/first.conf": "Include defaults.conf\n",
  "defaults.conf": "Host production\n  User nested-admin\n  Port 2227\n",
 }
 for name, value := range files {
  if err := os.WriteFile(filepath.Join(dir, name), []byte(value), 0600); err != nil { t.Fatal(err) }
 }
 got, err := readOpenSSHConfig(filepath.Join(dir,"config"), "production")
 if err != nil { t.Fatal(err) }
 if got.User != "nested-admin" || got.Port != 2227 { t.Fatalf("nested include not applied: %+v", got) }
}

func TestConfigNeverExecutesProxyCommandOrMatchExec(t *testing.T) {
 dir := t.TempDir()
 marker := filepath.Join(dir,"unexpected-exec")
 content := "Host ignored\n  ProxyCommand touch " + marker + "\nMatch exec touch " + marker + "\n  User hacker\nHost safe\n  HostName safe.internal\n"
 configPath := filepath.Join(dir,"config")
 if err := os.WriteFile(configPath, []byte(content), 0600); err != nil { t.Fatal(err) }
 got, err := readOpenSSHConfig(configPath,"safe")
 if err != nil { t.Fatal(err) }
 if got.HostName != "safe.internal" || got.User != "" { t.Fatalf("unsafe config resolution: %+v", got) }
 if _, err := os.Stat(marker); !os.IsNotExist(err) { t.Fatalf("config executed commands or marker unexpectedly exists: %v", err) }
}


func TestOpenSSHConfigConnectionTokens(t *testing.T) {
 dir := t.TempDir()
 configPath := filepath.Join(dir, "config")
 contents := "Host prod\n  HostName host.example.net\n  User deploy\n  Port 2222\n  IdentityFile ~/.ssh/%n-%h-%r-%p-%%.key\n  ProxyJump relay-%r@jump.example.net:22\n"
 if err := os.WriteFile(configPath, []byte(contents), 0600); err != nil { t.Fatal(err) }
 cfg, err := readOpenSSHConfig(configPath, "prod")
 if err != nil { t.Fatal(err) }
 host, user, port, key, jump := ApplySSHConfig("prod", "root", 22, "", "", cfg)
 if host != "host.example.net" || user != "deploy" || port != 2222 {
  t.Fatalf("unexpected resolved connection: %s %s %d", host, user, port)
 }
 if want := filepath.Join(".ssh", "prod-host.example.net-deploy-2222-%.key"); !strings.HasSuffix(key, want) {
  t.Fatalf("IdentityFile token expansion: %q (want suffix %q)", key, want)
 }
 if jump != "relay-deploy@jump.example.net:22" { t.Fatalf("ProxyJump expansion: %q", jump) }
}

func TestOpenSSHConfigExplicitIdentityOverridesConfiguredPath(t *testing.T) {
 cfg := SSHConfig{HostName: "remote.example.net", User: "deploy", Port: 2022, IdentityFile: "%d/.ssh/%r", ProxyJump: "relay-%h"}
 _, _, _, key, jump := ApplySSHConfig("alias", "root", 22, "/custom/private-key", "explicit-jump", cfg)
 if key != "/custom/private-key" || jump != "explicit-jump" {
  t.Fatalf("explicit user settings should take precedence: %q %q", key, jump)
 }
}
