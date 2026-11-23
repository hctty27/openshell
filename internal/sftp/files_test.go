package sftp

import (
    "bytes"
    "context"
    "errors"
    "os"
    "path/filepath"
    "strings"
    "testing"

    "github.com/hctty27/openshell/internal/domain"
    "golang.org/x/crypto/ssh"
)

func testManager() *Manager {
    return NewManager(func(domain.ConnectionRef)(*ssh.Client,error){ return nil,nil },func(string,any){})
}
func TestValidateFilePaths(t *testing.T) {
    if err:=validate("remote","/var/log");err!=nil {t.Fatal(err)}
    if err:=validate("remote","relative/path");err==nil {t.Fatal("relative remote path was accepted")}
    if err:=validate("other","/tmp");err==nil {t.Fatal("unknown side was accepted")}
    if err:=protectRoot("remote","/../");err==nil {t.Fatal("remote root was accepted")}
    if err:=protectRoot("local",filepath.Join(t.TempDir(),"new"));err!=nil {t.Fatal(err)}
}
func TestLocalFileOperations(t *testing.T) {
    m:=testManager()
    ref:=domain.ConnectionRef{}
    root:=t.TempDir()
    folder:=filepath.Join(root,"created")
    if err:=m.Operate(ref,"local","mkdir",folder,"");err!=nil {t.Fatal(err)}
    renamed:=filepath.Join(root,"renamed")
    if err:=m.Operate(ref,"local","rename",folder,renamed);err!=nil {t.Fatal(err)}
    if err:=m.Operate(ref,"local","rename",renamed,root);!errors.Is(err,os.ErrExist) {t.Fatalf("expected existing destination error, got %v",err)}
    items,err:=m.List(ref,"local",root)
    if err!=nil {t.Fatal(err)}
    if len(items)!=1 || items[0].Name!="renamed" || !items[0].IsDir {t.Fatalf("unexpected entries: %+v",items)}
    if err:=m.Operate(ref,"local","delete",renamed,"");err!=nil {t.Fatal(err)}
    if _,err:=os.Lstat(renamed);!errors.Is(err,os.ErrNotExist){t.Fatalf("not deleted: %v",err)}
}
func TestCopyContext(t *testing.T) {
    source:=strings.Repeat("transfer-payload-",20000)
    var output bytes.Buffer
    var progress int
    if err:=copyContext(context.Background(),&output,strings.NewReader(source),func(n int){progress+=n});err!=nil {t.Fatal(err)}
    if output.String()!=source || progress!=len(source) {t.Fatal("transfer mismatch")}
    ctx,cancel:=context.WithCancel(context.Background())
    cancel()
    if err:=copyContext(ctx,&bytes.Buffer{},strings.NewReader(source),func(int){});!errors.Is(err,context.Canceled) {t.Fatalf("expected cancellation, got %v",err)}
}
func TestConflictPolicy(t *testing.T) {
    root:=t.TempDir()
    name:=filepath.Join(root,"existing.txt")
    if err:=os.WriteFile(name,[]byte("original"),0600);err!=nil {t.Fatal(err)}
    if _,err:=checkTarget(os.Lstat,name,false);!errors.Is(err,os.ErrExist){t.Fatalf("expected no-clobber error: %v",err)}
    present,err:=checkTarget(os.Lstat,name,true)
    if err!=nil || !present {t.Fatalf("expected explicit overwrite option: %v",err)}
    present,err=checkTarget(os.Lstat,filepath.Join(root,"missing.txt"),false)
    if err!=nil || present {t.Fatalf("expected free target: %v",err)}
}

func TestLocalListResolvesSymlinkedDirectories(t *testing.T) {
    root := t.TempDir()
    target := filepath.Join(root, "zz-target")
    if err := os.Mkdir(target, 0o755); err != nil { t.Fatal(err) }
    if err := os.WriteFile(filepath.Join(root, "a-file.txt"), []byte("x"), 0o644); err != nil { t.Fatal(err) }
    if err := os.Symlink(target, filepath.Join(root, "b-link")); err != nil { t.Skipf("symlinks unavailable: %v", err) }
    if err := os.Symlink(filepath.Join(root, "a-file.txt"), filepath.Join(root, "c-file-link")); err != nil { t.Fatal(err) }
    items, err := testManager().List(domain.ConnectionRef{}, "local", root)
    if err != nil { t.Fatal(err) }
    names := make([]string, 0, len(items))
    byName := map[string]Entry{}
    for _, item := range items { names = append(names, item.Name); byName[item.Name] = item }
    if got := strings.Join(names, ","); got != "b-link,zz-target,a-file.txt,c-file-link" {
        t.Fatalf("directory-like entries should sort first: %s", got)
    }
    if link := byName["b-link"]; !link.IsSymlink || !link.TargetIsDir || link.IsDir {
        t.Fatalf("symlinked directory not resolved: %+v", link)
    }
    if link := byName["c-file-link"]; !link.IsSymlink || link.TargetIsDir {
        t.Fatalf("file symlink marked as directory: %+v", link)
    }
}
