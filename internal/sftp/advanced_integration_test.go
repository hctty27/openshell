//go:build !windows

package sftp

import (
    "bytes"
    "errors"
    "os"
    "path/filepath"
    "strings"
    "testing"
    "time"

    "github.com/hctty27/openshell/internal/domain"
    "golang.org/x/crypto/ssh"
)

func advancedManager(t *testing.T) (*Manager,domain.ConnectionRef) {
    t.Helper()
    client:=newFixture(t)
    ref:=domain.ConnectionRef{TabID:"advanced-test",SessionID:"advanced-host",Generation:1}
    m:=NewManager(func(got domain.ConnectionRef)(*ssh.Client,error){
        if got!=ref{return nil,errors.New("stale ref")}
        return client,nil
    },func(string,any){})
    t.Cleanup(m.Close)
    return m,ref
}
func TestAdvancedRemoteTextVersion(t *testing.T){
    m,ref:=advancedManager(t)
    root:=t.TempDir()
    name:=filepath.Join(root,"app.yaml")
    if err:=os.WriteFile(name,[]byte("port: 8080\n"),0640);err!=nil{t.Fatal(err)}
    doc,err:=m.ReadRemoteText(ref,name)
    if err!=nil||doc.Content!="port: 8080\n"{t.Fatalf("read: %+v %v",doc,err)}
    changed,err:=m.SaveRemoteText(ref,name,doc.Revision,"port: 9090\n")
    if err!=nil||changed.Revision==doc.Revision{t.Fatalf("save: %+v %v",changed,err)}
    if _,err=m.SaveRemoteText(ref,name,doc.Revision,"port: 7777\n");err==nil{t.Fatal("stale edit was accepted")}
    content,err:=os.ReadFile(name)
    if err!=nil||string(content)!="port: 9090\n"{t.Fatalf("save mismatch: %v",err)}
    info,err:=os.Stat(name)
    if err!=nil||info.Mode().Perm()!=0640{t.Fatalf("permissions lost: %v",err)}
    if _,err=m.SaveRemoteText(ref,name,changed.Revision,string([]byte{0xff}));err==nil{t.Fatal("binary data accepted")}
    big:=filepath.Join(root,"huge.txt")
    if err:=os.WriteFile(big,bytes.Repeat([]byte("a"),int(maxEditSize)+1),0600);err!=nil{t.Fatal(err)}
    if _,err=m.ReadRemoteText(ref,big);err==nil{t.Fatal("oversized text accepted")}
}
func TestSyncPreviewDoesNotDelete(t *testing.T){
    m,ref:=advancedManager(t)
    local,remote:=t.TempDir(),t.TempDir()
    common:=time.Now().Add(-2*time.Hour).Truncate(time.Second)
    create:=func(dir,name,body string,modified time.Time){
        t.Helper()
        file:=filepath.Join(dir,name)
        if err:=os.WriteFile(file,[]byte(body),0600);err!=nil{t.Fatal(err)}
        if err:=os.Chtimes(file,modified,modified);err!=nil{t.Fatal(err)}
    }
    create(local,"same.txt","same",common)
    create(remote,"same.txt","same",common)
    create(local,"changed.txt","new local content",common)
    create(remote,"changed.txt","newer remote content",common.Add(time.Hour))
    create(local,"missing.txt","local-only",common)
    create(remote,"remote-only.txt","preserve me",common)
    result,err:=m.PreviewSync(ref,"upload",local,remote)
    if err!=nil{t.Fatal(err)}
    seen:=map[string]string{}
    for _,a:=range result.Actions {
        seen[a.Relative]=a.Operation
        if a.Operation=="delete"{t.Fatal("non-destructive sync proposed deletion")}
    }
    if seen["missing.txt"]!="copy"||seen["changed.txt"]!="conflict"||result.Skipped<1{
        t.Fatalf("unexpected upload preview: %+v",result)
    }
    if _,exists:=seen["remote-only.txt"];exists{t.Fatal("remote-only files must not be deleted")}
    if _,err:=m.PreviewSync(ref,"both",local,remote);err==nil{t.Fatal("bidirectional sync incorrectly supported")}
}
func TestResumeTransfersVerifyPrefix(t *testing.T){
    m,ref:=advancedManager(t)
    local,remote:=t.TempDir(),t.TempDir()
    src:=filepath.Join(local,"payload.bin")
    dst:=filepath.Join(remote,"payload.bin")
    content:=[]byte(strings.Repeat("OpenShell-resume",32768))
    if err:=os.WriteFile(src,content,0600);err!=nil{t.Fatal(err)}
    partial:=partialName(src,dst)
    if err:=os.WriteFile(partial,content[:len(content)/2],0600);err!=nil{t.Fatal(err)}
    task,err:=m.Start(ref,"upload",src,dst,false,true)
    if err!=nil{t.Fatal(err)}
    result:=awaitTransfer(t,m,task)
    if result.Status!="completed"||result.Bytes!=int64(len(content)){t.Fatalf("resume upload: %+v",result)}
    received,err:=os.ReadFile(dst)
    if err!=nil||!bytes.Equal(received,content){t.Fatalf("resumed content mismatch: %v",err)}
    downloaded:=filepath.Join(local,"copy.bin")
    if err:=os.WriteFile(partialName(dst,downloaded),content[:len(content)/4],0600);err!=nil{t.Fatal(err)}
    task,err=m.Start(ref,"download",dst,downloaded,false,true)
    if err!=nil{t.Fatal(err)}
    result=awaitTransfer(t,m,task)
    if result.Status!="completed"{t.Fatalf("resume download: %+v",result)}
    received,err=os.ReadFile(downloaded)
    if err!=nil||!bytes.Equal(received,content){t.Fatalf("download content mismatch: %v",err)}
    bad:=filepath.Join(remote,"bad.bin")
    if err:=os.WriteFile(partialName(src,bad),[]byte("unrelated-data"),0600);err!=nil{t.Fatal(err)}
    task,err=m.Start(ref,"upload",src,bad,false,true)
    if err!=nil{t.Fatal(err)}
    result=awaitTransfer(t,m,task)
    if result.Status!="failed"{t.Fatalf("mismatched partial was accepted: %+v",result)}
    if _,err:=os.Lstat(bad);!errors.Is(err,os.ErrNotExist){t.Fatal("invalid resume created final file")}
    task,err=m.Start(ref,"upload",src,bad,false,false)
    if err!=nil{t.Fatal(err)}
    result=awaitTransfer(t,m,task)
    if result.Status!="completed"{t.Fatalf("restart failed: %+v",result)}
}
func TestBatchChmodSelected(t *testing.T){
    m,ref:=advancedManager(t)
    root:=t.TempDir()
    a,b:=filepath.Join(root,"a.txt"),filepath.Join(root,"b.txt")
    for _,p:=range []string{a,b}{if err:=os.WriteFile(p,[]byte("ok"),0600);err!=nil{t.Fatal(err)}}
    n,err:=m.BatchChmod(ref,"local",[]string{a,b},"0644")
    if err!=nil||n!=2{t.Fatalf("batch permissions: %d %v",n,err)}
    for _,p:=range []string{a,b}{
        info,err:=os.Stat(p)
        if err!=nil||info.Mode().Perm()!=0644{t.Fatalf("permissions: %s %v",p,err)}
    }
    if _,err:=m.BatchChmod(ref,"local",[]string{"/"},"0755");err==nil{t.Fatal("volume root allowed")}
}
