package sftp

import (
    "context"
    "errors"
    "fmt"
    "io"
    "os"
    "path"
    "path/filepath"
    "sort"
    "time"

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
    Error string `json:"error"`
    Created int64 `json:"created"`
}
type job struct {
    task Task
    ctx context.Context
    cancel context.CancelFunc
    slot chan struct{}
    last time.Time
}
var errSymlink = errors.New("symbolic links are not included in transfers")

func (m *Manager) Start(ref domain.ConnectionRef, direction, source, destination string) (Task, error) {
    if direction != "upload" && direction != "download" { return Task{}, errors.New("invalid transfer direction") }
    src, dst := "local", "remote"
    if direction == "download" { src, dst = "remote", "local" }
    if err := validate(src, source); err != nil { return Task{}, err }
    if err := protectRoot(dst, destination); err != nil { return Task{}, err }
    if _, err := m.lookup(ref); err != nil { return Task{}, err }
    ctx, cancel := context.WithCancel(context.Background())
    task := Task{ID:domain.NewID(), Ref:ref, Direction:direction, Source:source,
        Destination:destination, Name:filepath.Base(source), Status:"queued", Created:time.Now().UnixMilli()}
    if direction == "download" { task.Name = path.Base(source) }
    m.mu.Lock()
    if m.closed { m.mu.Unlock(); cancel(); return Task{}, errors.New("file manager closed") }
    slot := m.slots[ref.SessionID]
    if slot == nil { slot = make(chan struct{},2); m.slots[ref.SessionID] = slot }
    j := &job{task:task,ctx:ctx,cancel:cancel,slot:slot}
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
func (m *Manager) upload(j *job,c *pkg.Client,src,dst string) error {
    if err:=j.ctx.Err();err!=nil{return err}
    info,err:=os.Lstat(src)
    if err!=nil{return err}
    if info.Mode()&os.ModeSymlink!=0{return errSymlink}
    if info.IsDir() {
        remote,err:=c.Lstat(dst)
        if errors.Is(err,os.ErrNotExist) {
            if err=c.Mkdir(dst);err!=nil{return err}
        } else if err!=nil{return err} else if !remote.IsDir() {return fmt.Errorf("target is not a directory: %s",dst)}
        entries,err:=os.ReadDir(src)
        if err!=nil{return err}
        for _,ent:=range entries {
            if err=m.upload(j,c,filepath.Join(src,ent.Name()),path.Join(dst,ent.Name()));err!=nil{return err}
        }
        return nil
    }
    if err:=checkNotExists(c.Lstat,dst);err!=nil{return err}
    reader,err:=os.Open(src)
    if err!=nil{return err}
    defer reader.Close()
    tmp:=dst+".openshell-"+j.task.ID+".part"
    writer,err:=c.OpenFile(tmp,os.O_CREATE|os.O_EXCL|os.O_WRONLY)
    if err!=nil{return err}
    defer c.Remove(tmp)
    err=copyContext(j.ctx,writer,reader,func(n int){m.progress(j,n)})
    closeErr:=writer.Close()
    if err!=nil{return err}
    if closeErr!=nil{return closeErr}
    if err=checkNotExists(c.Lstat,dst);err!=nil{return err}
    if err=c.Rename(tmp,dst);err!=nil{return err}
    return c.Chmod(dst,info.Mode().Perm())
}
func (m *Manager) download(j *job,c *pkg.Client,src,dst string) error {
    if err:=j.ctx.Err();err!=nil{return err}
    info,err:=c.Lstat(src)
    if err!=nil{return err}
    if info.Mode()&os.ModeSymlink!=0{return errSymlink}
    if info.IsDir() {
        local,err:=os.Lstat(dst)
        if errors.Is(err,os.ErrNotExist) {
            if err=os.Mkdir(dst,0755);err!=nil{return err}
        }else if err!=nil{return err}else if !local.IsDir(){return fmt.Errorf("target is not a directory: %s",dst)}
        entries,err:=c.ReadDir(src)
        if err!=nil{return err}
        for _,ent:=range entries {
            if err=m.download(j,c,path.Join(src,ent.Name()),filepath.Join(dst,ent.Name()));err!=nil{return err}
        }
        return nil
    }
    if err:=checkNotExists(os.Lstat,dst);err!=nil{return err}
    reader,err:=c.Open(src)
    if err!=nil{return err}
    defer reader.Close()
    tmp:=dst+".openshell-"+j.task.ID+".part"
    writer,err:=os.OpenFile(tmp,os.O_CREATE|os.O_EXCL|os.O_WRONLY,0600)
    if err!=nil{return err}
    defer os.Remove(tmp)
    err=copyContext(j.ctx,writer,reader,func(n int){m.progress(j,n)})
    closeErr:=writer.Close()
    if err!=nil{return err}
    if closeErr!=nil{return closeErr}
    if err=checkNotExists(os.Lstat,dst);err!=nil{return err}
    if err=os.Rename(tmp,dst);err!=nil{return err}
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
