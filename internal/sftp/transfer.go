package sftp

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "bytes"
    "errors"
    "io"
    "os"
    "path"
    "path/filepath"
    "sort"
    "time"

    "github.com/hctty27/openshell/internal/apperror"
    "github.com/hctty27/openshell/internal/domain"
    pkg "github.com/pkg/sftp"
)
type Task struct {
    ID string `json:"id"`
    Ref domain.ConnectionRef `json:"ref"`
    Direction string `json:"direction"`
    Source string `json:"source"`
    Destination string `json:"destination"`
    Name string `json:"name"`
    Bytes int64 `json:"bytes"`
    Total int64 `json:"total"`
    Status string `json:"status"`
    Overwrite bool `json:"overwrite"`
    Resume bool `json:"resume"`
    Error string `json:"error"`
    Created int64 `json:"created"`
}
type job struct {
    task Task
    ctx context.Context
    cancel context.CancelFunc
    slot chan struct{}
    reservation string
    last time.Time
}
var errSymlink = apperror.New("sftpTransferSymbolicLinksAreNotIncludedInTransfers",nil)

func (m *Manager) Start(ref domain.ConnectionRef, direction, source, destination string, overwrite bool, resumeChoice ...bool) (Task, error) {
    if direction != "upload" && direction != "download" { return Task{}, apperror.New("sftpTransferInvalidTransferDirection",nil) }
    src, dst := "local", "remote"
    if direction == "download" { src, dst = "remote", "local" }
    if err := validate(src, source); err != nil { return Task{}, err }
    if err := protectRoot(dst, destination); err != nil { return Task{}, err }
    if _, err := m.lookup(ref); err != nil { return Task{}, err }
    resume := true
    if len(resumeChoice)>0 {resume=resumeChoice[0]}
    ctx, cancel := context.WithCancel(context.Background())
    task := Task{ID:domain.NewID(), Ref:ref, Direction:direction, Source:source,
        Destination:destination, Name:filepath.Base(source), Overwrite:overwrite, Resume:resume, Status:"queued", Created:time.Now().UnixMilli()}
    if direction == "download" { task.Name = path.Base(source) }
    m.mu.Lock()
    if m.closed { m.mu.Unlock(); cancel(); return Task{}, apperror.New("sftpTransferFileManagerClosed",nil) }
    canonical := path.Clean(destination)
    if dst == "local" { canonical = filepath.Clean(destination) }
    reservation := ref.SessionID + "|" + direction + "|" + canonical
    if _, busy := m.reserved[reservation]; busy {
        m.mu.Unlock()
        cancel()
        return Task{}, apperror.New("sftpTransferAnotherTransferAlreadyTargetsThisPath",nil)
    }
    m.reserved[reservation] = struct{}{}
    slot := m.slots[ref.SessionID]
    if slot == nil { slot = make(chan struct{},2); m.slots[ref.SessionID] = slot }
    j := &job{task:task,ctx:ctx,cancel:cancel,slot:slot,reservation:reservation}
    m.tasks[task.ID] = j
    m.mu.Unlock()
    m.emit("sftp:transfer", task)
    go m.run(j)
    return task,nil
}
func (m *Manager) Transfers(ref domain.ConnectionRef) []Task {
    m.mu.Lock()
    defer m.mu.Unlock()
    out := make([]Task,0)
    for _, j := range m.tasks {
        if j.task.Ref.TabID == ref.TabID && j.task.Ref.SessionID == ref.SessionID {
            out = append(out,j.task)
        }
    }
    sort.Slice(out,func(i,j int) bool { return out[i].Created < out[j].Created })
    return out
}
func (m *Manager) Cancel(id string) error {
    m.mu.Lock()
    j := m.tasks[id]
    m.mu.Unlock()
    if j == nil { return os.ErrNotExist }
    j.cancel()
    return nil
}
func (m *Manager) CancelConnection(ref domain.ConnectionRef) {
    m.mu.Lock()
    var cancels []context.CancelFunc
    for _,j := range m.tasks {
        if j.task.Ref == ref && (j.task.Status == "queued" || j.task.Status == "running") {
            cancels = append(cancels,j.cancel)
        }
    }
    m.mu.Unlock()
    for _,cancel := range cancels { cancel() }
}
func (m *Manager) Close() {
    m.mu.Lock()
    m.closed = true
    var cancels []context.CancelFunc
    for _,j := range m.tasks { cancels=append(cancels,j.cancel) }
    m.mu.Unlock()
    for _,cancel:=range cancels { cancel() }
}
func (m *Manager) update(j *job, fn func(*Task)) {
    m.mu.Lock()
    fn(&j.task)
    snapshot := j.task
    m.mu.Unlock()
    m.emit("sftp:transfer",snapshot)
}
func (m *Manager) progress(j *job,n int) {
    m.mu.Lock()
    j.task.Bytes+=int64(n)
    now:=time.Now()
    send:=now.Sub(j.last)>=180*time.Millisecond || j.task.Bytes>=j.task.Total
    if send { j.last=now }
    snap:=j.task
    m.mu.Unlock()
    if send { m.emit("sftp:transfer",snap) }
}
func (m *Manager) run(j *job) {
    defer func() {
        m.mu.Lock()
        delete(m.reserved, j.reservation)
        m.mu.Unlock()
    }()
    select {
    case j.slot<-struct{}{}:
        defer func(){ <-j.slot }()
    case <-j.ctx.Done():
        m.update(j,func(t *Task){t.Status="cancelled"})
        return
    }
    if err:=j.ctx.Err();err!=nil {
        m.update(j,func(t *Task){t.Status="cancelled"})
        return
    }
    m.update(j,func(t *Task){t.Status="running"})
    err:=m.transfer(j)
    switch {
    case j.ctx.Err()!=nil:
        m.update(j,func(t *Task){t.Status="cancelled"})
    case err!=nil:
        m.update(j,func(t *Task){t.Status="failed";t.Error=err.Error()})
    default:
        m.update(j,func(t *Task){t.Status="completed"})
    }
}

func (m *Manager) transfer(j *job) error {
    c,err:=m.remote(j.task.Ref)
    if err!=nil {return err}
    done:=make(chan struct{})
    go func() {
        select {
        case <-j.ctx.Done(): c.Close()
        case <-done:
        }
    }()
    defer close(done)
    defer c.Close()
    var total int64
    if j.task.Direction=="upload" {
        total,err=sizeLocal(j.task.Source)
    } else {
        total,err=sizeRemote(c,j.task.Source)
    }
    if err!=nil {return err}
    m.update(j,func(t *Task){t.Total=total})
    if j.task.Direction=="upload" {
        return m.upload(j,c,j.task.Source,j.task.Destination)
    }
    return m.download(j,c,j.task.Source,j.task.Destination)
}
func sizeLocal(source string)(int64,error) {
    info,err:=os.Lstat(source)
    if err!=nil{return 0,err}
    if info.Mode()&os.ModeSymlink!=0{return 0,errSymlink}
    if !info.IsDir(){return info.Size(),nil}
    entries,err:=os.ReadDir(source)
    if err!=nil{return 0,err}
    var total int64
    for _,ent:=range entries {
        n,err:=sizeLocal(filepath.Join(source,ent.Name()))
        if err!=nil{return 0,err}
        total+=n
    }
    return total,nil
}
func sizeRemote(c *pkg.Client,source string)(int64,error) {
    info,err:=c.Lstat(source)
    if err!=nil{return 0,err}
    if info.Mode()&os.ModeSymlink!=0{return 0,errSymlink}
    if !info.IsDir(){return info.Size(),nil}
    entries,err:=c.ReadDir(source)
    if err!=nil{return 0,err}
    var total int64
    for _,ent:=range entries {
        n,err:=sizeRemote(c,path.Join(source,ent.Name()))
        if err!=nil{return 0,err}
        total+=n
    }
    return total,nil
}
// Partial files are deterministic across app restarts. Prefix hashes are
// checked before resuming; a changed source never appends to stale data.
func partialName(source,destination string) string {
    digest:=sha256.Sum256([]byte(source+"\x00"+destination))
    return destination+".openshell-"+hex.EncodeToString(digest[:8])+".part"
}
func prefixMatches(left,right io.Reader,n int64) (bool,error) {
    a,b:=sha256.New(),sha256.New()
    if _,err:=io.CopyN(a,left,n);err!=nil{return false,err}
    if _,err:=io.CopyN(b,right,n);err!=nil{return false,err}
    return bytes.Equal(a.Sum(nil),b.Sum(nil)),nil
}
func (m *Manager) upload(j *job,c *pkg.Client,src,dst string) error {
    if err:=j.ctx.Err();err!=nil{return err}
    info,err:=os.Lstat(src)
    if err!=nil{return err}
    if info.Mode()&os.ModeSymlink!=0{return errSymlink}
    if info.IsDir(){
        remote,err:=c.Lstat(dst)
        if errors.Is(err,os.ErrNotExist){
            if err=c.Mkdir(dst);err!=nil{return err}
        }else if err!=nil{return err}else if !remote.IsDir(){return apperror.New("sftpTargetNotDirectory",map[string]any{"path":dst})}
        entries,err:=os.ReadDir(src)
        if err!=nil{return err}
        for _,ent:=range entries {
            if err=m.upload(j,c,filepath.Join(src,ent.Name()),path.Join(dst,ent.Name()));err!=nil{return err}
        }
        return nil
    }
    if _,err=checkTarget(c.Lstat,dst,j.task.Overwrite);err!=nil{return err}
    reader,err:=os.Open(src)
    if err!=nil{return err}
    defer reader.Close()
    temp:=partialName(src,dst)
    var offset int64
    existed:=false
    part,err:=c.Lstat(temp)
    if err!=nil && !errors.Is(err,os.ErrNotExist){return err}
    if err==nil {
        existed=true
        if !part.Mode().IsRegular(){return apperror.New("sftpTransferPartialUploadTargetIsNotARegularFile",nil)}
        if !j.task.Resume {
            if err=c.Remove(temp);err!=nil{return err}
            existed=false
        }else{
            offset=part.Size()
            if offset>info.Size(){return apperror.New("sftpTransferPartialUploadIsLargerThanTheSourceRestartTransfer",nil)}
            prefix,err:=c.Open(temp)
            if err!=nil{return err}
            match,checkErr:=prefixMatches(reader,prefix,offset)
            closeErr:=prefix.Close()
            if checkErr!=nil{return checkErr}
            if closeErr!=nil{return closeErr}
            if !match{return apperror.New("sftpTransferPartialUploadDiffersFromSourceRestartTransfer",nil)}
        }
    }
    if _,err=reader.Seek(offset,io.SeekStart);err!=nil{return err}
    flags:=os.O_WRONLY
    if !existed {flags=os.O_WRONLY|os.O_CREATE|os.O_EXCL}
    writer,err:=c.OpenFile(temp,flags)
    if err!=nil{return err}
    if offset>0 {
        if _,err=writer.Seek(offset,io.SeekStart);err!=nil{writer.Close();return err}
        m.progress(j,int(offset))
    }
    err=copyContext(j.ctx,writer,reader,func(n int){m.progress(j,n)})
    closeErr:=writer.Close()
    if err!=nil{return err}
    if closeErr!=nil{return closeErr}
    after,err:=os.Stat(src)
    if err!=nil{return err}
    if after.Size()!=info.Size() || !after.ModTime().Equal(info.ModTime()) {return apperror.New("sftpTransferSourceFileChangedDuringUpload",nil)}
    exists,err:=checkTarget(c.Lstat,dst,j.task.Overwrite)
    if err!=nil{return err}
    if exists{err=c.PosixRename(temp,dst)}else{err=c.Rename(temp,dst)}
    if err!=nil{return err}
    return c.Chmod(dst,info.Mode().Perm())
}
func (m *Manager) download(j *job,c *pkg.Client,src,dst string) error {
    if err:=j.ctx.Err();err!=nil{return err}
    info,err:=c.Lstat(src)
    if err!=nil{return err}
    if info.Mode()&os.ModeSymlink!=0{return errSymlink}
    if info.IsDir(){
        local,err:=os.Lstat(dst)
        if errors.Is(err,os.ErrNotExist){
            if err=os.Mkdir(dst,0755);err!=nil{return err}
        }else if err!=nil{return err}else if !local.IsDir(){return apperror.New("sftpTargetNotDirectory",map[string]any{"path":dst})}
        entries,err:=c.ReadDir(src)
        if err!=nil{return err}
        for _,ent:=range entries {
            if err=m.download(j,c,path.Join(src,ent.Name()),filepath.Join(dst,ent.Name()));err!=nil{return err}
        }
        return nil
    }
    if _,err=checkTarget(os.Lstat,dst,j.task.Overwrite);err!=nil{return err}
    reader,err:=c.Open(src)
    if err!=nil{return err}
    defer reader.Close()
    temp:=partialName(src,dst)
    var offset int64
    existed:=false
    part,err:=os.Lstat(temp)
    if err!=nil && !errors.Is(err,os.ErrNotExist){return err}
    if err==nil{
        existed=true
        if !part.Mode().IsRegular(){return apperror.New("sftpTransferPartialDownloadTargetIsNotARegularFile",nil)}
        if !j.task.Resume{
            if err=os.Remove(temp);err!=nil{return err}
            existed=false
        }else{
            offset=part.Size()
            if offset>info.Size(){return apperror.New("sftpTransferPartialDownloadIsLargerThanSourceRestartTransfer",nil)}
            existing,err:=os.Open(temp)
            if err!=nil{return err}
            match,checkErr:=prefixMatches(reader,existing,offset)
            closeErr:=existing.Close()
            if checkErr!=nil{return checkErr}
            if closeErr!=nil{return closeErr}
            if !match{return apperror.New("sftpTransferPartialDownloadDiffersFromSourceRestartTransfer",nil)}
        }
    }
    if _,err=reader.Seek(offset,io.SeekStart);err!=nil{return err}
    flags:=os.O_WRONLY
    if !existed{flags=os.O_WRONLY|os.O_CREATE|os.O_EXCL}
    writer,err:=os.OpenFile(temp,flags,0600)
    if err!=nil{return err}
    if offset>0{
        if _,err=writer.Seek(offset,io.SeekStart);err!=nil{writer.Close();return err}
        m.progress(j,int(offset))
    }
    err=copyContext(j.ctx,writer,reader,func(n int){m.progress(j,n)})
    closeErr:=writer.Close()
    if err!=nil{return err}
    if closeErr!=nil{return closeErr}
    after,err:=c.Lstat(src)
    if err!=nil{return err}
    if info.Size()!=after.Size() || !info.ModTime().Equal(after.ModTime()) {return apperror.New("sftpTransferSourceFileChangedDuringDownload",nil)}
    if _,err=checkTarget(os.Lstat,dst,j.task.Overwrite);err!=nil{return err}
    if err=os.Rename(temp,dst);err!=nil{return err}
    return os.Chmod(dst,info.Mode().Perm())
}
func copyContext(ctx context.Context,dst io.Writer,src io.Reader,progress func(int)) error {
    buf:=make([]byte,128*1024)
    for {
        if err:=ctx.Err();err!=nil{return err}
        n,err:=src.Read(buf)
        if n>0 {
            count,werr:=dst.Write(buf[:n])
            if count>0{progress(count)}
            if werr!=nil{return werr}
            if count!=n{return io.ErrShortWrite}
        }
        if err==io.EOF{return nil}
        if err!=nil{return err}
    }
}

func (m *Manager) CancelTab(tabID string) {
    m.mu.Lock()
    var cancels []context.CancelFunc
    for _, j := range m.tasks {
        if j.task.Ref.TabID == tabID && (j.task.Status == "queued" || j.task.Status == "running") {
            cancels = append(cancels, j.cancel)
        }
    }
    m.mu.Unlock()
    for _, cancel := range cancels { cancel() }
}

func checkTarget(check func(string)(os.FileInfo,error), destination string, overwrite bool)(bool,error){
    info,err:=check(destination)
    if errors.Is(err,os.ErrNotExist){return false,nil}
    if err!=nil{return false,err}
    if info.IsDir(){return true,apperror.New("sftpDestinationIsDirectory",map[string]any{"path":destination})}
    if !overwrite{return true,os.ErrExist}
    return true,nil
}
