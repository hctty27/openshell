//go:build !windows

package sftp

import (
  "os"
  "path/filepath"
  "strings"
  "testing"

  "github.com/hctty27/openshell/internal/domain"
  "golang.org/x/crypto/ssh"
)

func TestSFTPAIReadBoundedAndProtected(t *testing.T) {
  client:=newFixture(t)
  ref:=domain.ConnectionRef{TabID:"sftp-ai",SessionID:"server",Generation:1}
  m:=NewManager(func(got domain.ConnectionRef)(*ssh.Client,error){
    if got!=ref {t.Fatalf("wrong ref")}
    return client,nil
  },func(string,any){})
  defer m.Close()
  dir:=t.TempDir()
  file:=filepath.Join(dir,"service.log")
  text:=strings.Repeat("INFO ready\n",5000)+"ERROR database timeout\n"
  if err:=os.WriteFile(file,[]byte(text),0600);err!=nil{t.Fatal(err)}
  excerpt,err:=m.ReadAIExcerpt(ref,file,true,false)
  if err!=nil{t.Fatal(err)}
  if !excerpt.Truncated || !strings.Contains(excerpt.Content,"ERROR database timeout") || len(excerpt.Content)>int(aiReadLimit) {t.Fatalf("invalid tail: %+v",excerpt)}
  if _,err:=m.ReadAIExcerpt(ref,file,false,true);err==nil {t.Fatal("oversized edit context accepted")}
  secret:=filepath.Join(dir,".env")
  if err:=os.WriteFile(secret,[]byte("PASSWORD=hunter2"),0600);err!=nil{t.Fatal(err)}
  if _,err:=m.ReadAIExcerpt(ref,secret,false,false);err==nil {t.Fatal("secret file accepted")}
  if err:=os.Symlink(file,filepath.Join(dir,"linked.log"));err!=nil{t.Fatal(err)}
  if _,err:=m.ReadAIExcerpt(ref,filepath.Join(dir,"linked.log"),false,false);err==nil {t.Fatal("symlink accepted")}
}
