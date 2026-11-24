//go:build !windows

package sftp

import (
    "os"
    "path/filepath"
    "strings"
    "testing"
)

func TestAIResolveRemotePathRejectsUnverifiedSymlinks(t *testing.T) {
    m,ref:=advancedManager(t)
    root:=t.TempDir()
    target:=filepath.Join(root,"safe.txt")
    if err:=os.WriteFile(target,[]byte("safe"),0600);err!=nil{t.Fatal(err)}
    normal,linked,err:=m.AIResolveRemotePath(ref,target)
    if err!=nil || linked || normal!=target {
        t.Fatalf("plain remote file: resolved=%q linked=%v err=%v",normal,linked,err)
    }
    alias:=filepath.Join(root,"alias.txt")
    if err:=os.Symlink(target,alias);err!=nil{t.Skipf("symlink unavailable: %v",err)}
    resolved,linked,err:=m.AIResolveRemotePath(ref,alias)
    // An OpenSSH server resolves the link. Other SFTP servers may not;
    // those must fail closed rather than returning the sensitive alias.
    if err==nil && (!linked || resolved!=target) {
        t.Fatalf("symlink not safely resolved: resolved=%q linked=%v",resolved,linked)
    }
    _,_,err=m.AIResolveRemotePath(ref,filepath.Join(root,"..","..",filepath.Base(root)))
    // filepath.Join removes '..', so test the literal traversal separately.
    _,_,err=m.AIResolveRemotePath(ref,root+"/../"+filepath.Base(root)+"/safe.txt")
    if err==nil || !strings.Contains(err.Error(),"..") {t.Fatalf("traversal allowed: %v",err)}
}
