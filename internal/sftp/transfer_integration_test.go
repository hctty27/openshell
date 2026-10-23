//go:build !windows

package sftp

import (
    "bytes"
    "crypto/ed25519"
    "crypto/rand"
    "errors"
    "os"
    "path/filepath"
    "strings"
    "testing"
    "time"
    "net"

    "github.com/hctty27/openshell/internal/domain"
    pkg "github.com/pkg/sftp"
    "golang.org/x/crypto/ssh"
)

func newFixture(t *testing.T) *ssh.Client {
    t.Helper()
    _, key, err := ed25519.GenerateKey(rand.Reader)
    if err != nil { t.Fatal(err) }
    signer, err := ssh.NewSignerFromKey(key)
    if err != nil { t.Fatal(err) }
    cfg := &ssh.ServerConfig{NoClientAuth: true}
    cfg.AddHostKey(signer)
    listener, err := net.Listen("tcp", "127.0.0.1:0")
    if err != nil { t.Fatal(err) }
    go func() {
        for {
            conn, err := listener.Accept()
            if err != nil { return }
            go func(conn net.Conn) {
                server, channels, requests, err := ssh.NewServerConn(conn, cfg)
                if err != nil { conn.Close(); return }
                defer server.Close()
                go ssh.DiscardRequests(requests)
                for request := range channels {
                    if request.ChannelType() != "session" {
                        request.Reject(ssh.UnknownChannelType, "only SFTP sessions")
                        continue
                    }
                    channel, in, err := request.Accept()
                    if err != nil { continue }
                    go func(channel ssh.Channel, requests <-chan *ssh.Request) {
                        defer channel.Close()
                        for req := range requests {
                            if req.Type != "subsystem" || len(req.Payload) < 4 || string(req.Payload[4:]) != "sftp" {
                                req.Reply(false, nil)
                                continue
                            }
                            req.Reply(true, nil)
                            srv, err := pkg.NewServer(channel)
                            if err == nil {
                                _ = srv.Serve()
                                _ = srv.Close()
                            }
                            return
                        }
                    }(channel, in)
                }
            }(conn)
        }
    }()
    client, err := ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{
        User: "test", HostKeyCallback: ssh.InsecureIgnoreHostKey(),
    })
    if err != nil { listener.Close(); t.Fatal(err) }
    t.Cleanup(func() { client.Close(); listener.Close() })
    return client
}

func awaitTransfer(t *testing.T, m *Manager, task Task) Task {
    t.Helper()
    deadline := time.Now().Add(12 * time.Second)
    for time.Now().Before(deadline) {
        for _, current := range m.Transfers(task.Ref) {
            if current.ID != task.ID { continue }
            switch current.Status {
            case "completed", "failed", "cancelled":
                return current
            }
        }
        time.Sleep(15 * time.Millisecond)
    }
    t.Fatalf("transfer did not complete: %s", task.ID)
    return Task{}
}

func TestSFTPRealProtocolRoundTrip(t *testing.T) {
    client := newFixture(t)
    ref := domain.ConnectionRef{TabID: "tab-1", SessionID: "test-server", Generation: 1}
    manager := NewManager(func(actual domain.ConnectionRef) (*ssh.Client,error) {
        if actual != ref { return nil, errors.New("unexpected SSH connection") }
        return client, nil
    }, func(string, any){})
    t.Cleanup(manager.Close)

    local := t.TempDir()
    remote := t.TempDir()
    source := filepath.Join(local,"test.txt")
    destination := filepath.Join(remote,"test.txt")
    content := []byte(strings.Repeat("OpenShell-SFTP-",8192))
    if err := os.WriteFile(source,content,0644); err != nil { t.Fatal(err) }

    homes, err := manager.Homes(ref)
    if err != nil || homes.Local == "" || homes.Remote == "" { t.Fatalf("get homes: %+v: %v",homes,err) }
    task, err := manager.Start(ref,"upload",source,destination,false)
    if err != nil { t.Fatal(err) }
    result := awaitTransfer(t,manager,task)
    if result.Status != "completed" || result.Bytes != int64(len(content)) || result.Total != int64(len(content)) {
        t.Fatalf("upload result: %+v",result)
    }
    uploaded, err := os.ReadFile(destination)
    if err != nil || !bytes.Equal(uploaded,content) { t.Fatalf("upload corrupted: %v",err) }

    entries, err := manager.List(ref,"remote",remote)
    if err != nil || len(entries) != 1 || entries[0].Name != "test.txt" { t.Fatalf("remote list: %+v %v",entries,err) }

    collision, err := manager.Start(ref,"upload",source,destination,false)
    if err != nil { t.Fatal(err) }
    if failure := awaitTransfer(t,manager,collision); failure.Status != "failed" {
        t.Fatalf("unconfirmed overwrite was accepted: %+v",failure)
    }
    newContent := []byte("replaced, after explicit confirmation")
    if err := os.WriteFile(source,newContent,0644);err != nil { t.Fatal(err) }
    replacement,err:=manager.Start(ref,"upload",source,destination,true)
    if err != nil { t.Fatal(err) }
    if outcome:=awaitTransfer(t,manager,replacement);outcome.Status!="completed" { t.Fatalf("overwrite: %+v",outcome) }
    actual,err:=os.ReadFile(destination)
    if err != nil || !bytes.Equal(actual,newContent) { t.Fatalf("overwrite corrupted: %v",err) }

    downloaded:=filepath.Join(local,"download.txt")
    download,err:=manager.Start(ref,"download",destination,downloaded,false)
    if err != nil {t.Fatal(err)}
    if outcome:=awaitTransfer(t,manager,download);outcome.Status!="completed" { t.Fatalf("download: %+v",outcome)}
    actual,err=os.ReadFile(downloaded)
    if err!=nil || !bytes.Equal(actual,newContent){t.Fatalf("download corrupted: %v",err)}

    renamed:=filepath.Join(remote,"renamed.txt")
    if err:=manager.Operate(ref,"remote","rename",destination,renamed);err!=nil {t.Fatal(err)}
    if err:=manager.Operate(ref,"remote","chmod",renamed,"0600");err!=nil {t.Fatal(err)}
    if err:=manager.Operate(ref,"remote","delete",renamed,"");err!=nil {t.Fatal(err)}
    if _,err:=os.Lstat(renamed);!errors.Is(err,os.ErrNotExist){t.Fatalf("remote deletion failed: %v",err)}
}

func TestSFTPTransferDestinationIsReserved(t *testing.T) {
    client := newFixture(t)
    ref := domain.ConnectionRef{TabID:"tab-two",SessionID:"shared-server",Generation:1}
    manager:=NewManager(func(domain.ConnectionRef)(*ssh.Client,error){return client,nil},func(string,any){})
    t.Cleanup(manager.Close)
    src:=filepath.Join(t.TempDir(),"source.txt")
    if err:=os.WriteFile(src,[]byte("payload"),0600);err!=nil {t.Fatal(err)}
    dst:=filepath.Join(t.TempDir(),"target.txt")

    // Saturate the two slots so the first job stays queued deterministically.
    occupied:=make(chan struct{},2)
    occupied<-struct{}{}
    occupied<-struct{}{}
    manager.mu.Lock()
    manager.slots[ref.SessionID]=occupied
    manager.mu.Unlock()

    first,err:=manager.Start(ref,"upload",src,dst,false)
    if err!=nil {t.Fatal(err)}
    if _,err=manager.Start(ref,"upload",src,dst,true);err==nil {
        t.Fatal("duplicate destination was not rejected")
    }
    if err:=manager.Cancel(first.ID);err!=nil {t.Fatal(err)}
    <-occupied
    <-occupied
    if result:=awaitTransfer(t,manager,first);result.Status!="cancelled" {
        t.Fatalf("queued job not cancelled: %+v",result)
    }
}


func TestSFTPLargeFileResumeAndAtomicPromotion(t *testing.T) {
 client := newFixture(t)
 ref := domain.ConnectionRef{TabID:"large-tab",SessionID:"large-server",Generation:1}
 manager := NewManager(func(domain.ConnectionRef)(*ssh.Client,error){return client,nil},func(string,any){})
 t.Cleanup(manager.Close)

 root := t.TempDir()
 source := filepath.Join(root,"large-source.dat")
 remote := filepath.Join(t.TempDir(),"large-remote.dat")
 downloaded := filepath.Join(root,"downloaded.dat")
 content := []byte(strings.Repeat("OpenShell-large-transfer-0123456789-", 160000))
 if err := os.WriteFile(source,content,0600);err!=nil{t.Fatal(err)}
 prefix := 1<<20
 uploadPart := partialName(source,remote)
 if err := os.WriteFile(uploadPart,content[:prefix],0600);err!=nil{t.Fatal(err)}
 upload,err := manager.Start(ref,"upload",source,remote,false,true)
 if err!=nil{t.Fatal(err)}
 if result:=awaitTransfer(t,manager,upload);result.Status!="completed" || result.Bytes!=int64(len(content)){
  t.Fatalf("large resumed upload: %+v",result)
 }
 got,err:=os.ReadFile(remote)
 if err!=nil || !bytes.Equal(got,content){t.Fatalf("uploaded file corrupted: %v",err)}
 if _,err:=os.Lstat(uploadPart);!errors.Is(err,os.ErrNotExist){t.Fatalf("upload temporary file remains: %v",err)}

 downloadPart := partialName(remote,downloaded)
 if err:=os.WriteFile(downloadPart,content[:prefix],0600);err!=nil{t.Fatal(err)}
 download,err:=manager.Start(ref,"download",remote,downloaded,false,true)
 if err!=nil{t.Fatal(err)}
 if result:=awaitTransfer(t,manager,download);result.Status!="completed" || result.Bytes!=int64(len(content)){
  t.Fatalf("large resumed download: %+v",result)
 }
 got,err=os.ReadFile(downloaded)
 if err!=nil || !bytes.Equal(got,content){t.Fatalf("downloaded file corrupted: %v",err)}
 if _,err:=os.Lstat(downloadPart);!errors.Is(err,os.ErrNotExist){t.Fatalf("download temporary file remains: %v",err)}
}
