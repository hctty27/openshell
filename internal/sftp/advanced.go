package sftp

import (
    "crypto/sha256"
    "encoding/hex"
    "errors"
    "fmt"
    "io"
    "os"
    "path"
    "path/filepath"
    "sort"
    "strings"
    "time"
    "unicode/utf8"

    "github.com/hctty27/openshell/internal/domain"
    pkg "github.com/pkg/sftp"
)

const maxEditSize int64 = 1024 * 1024
const maxSyncEntries = 4000

// RemoteDocument uses optimistic concurrency: only the version read can be saved.
type RemoteDocument struct {
    Path string `json:"path"`
    Content string `json:"content"`
    Revision string `json:"revision"`
    Size int64 `json:"size"`
}

func loadDocument(c *pkg.Client, name string) (RemoteDocument, error) {
    info, err := c.Lstat(name)
    if err != nil { return RemoteDocument{}, err }
    if !info.Mode().IsRegular() { return RemoteDocument{}, errors.New("only regular text files can be edited") }
    if info.Size() > maxEditSize { return RemoteDocument{}, fmt.Errorf("text editor limit is %d bytes", maxEditSize) }
    f, err := c.Open(name)
    if err != nil { return RemoteDocument{}, err }
    defer f.Close()
    content, err := io.ReadAll(io.LimitReader(f,maxEditSize+1))
    if err != nil { return RemoteDocument{}, err }
    if int64(len(content)) > maxEditSize { return RemoteDocument{}, errors.New("file exceeds text editor limit") }
    if !utf8.Valid(content) || strings.IndexByte(string(content),0) >= 0 { return RemoteDocument{}, errors.New("not a UTF-8 text file") }
    digest := sha256.Sum256(content)
    return RemoteDocument{Path:name,Content:string(content),Revision:hex.EncodeToString(digest[:]),Size:int64(len(content))},nil
}

func (m *Manager) ReadRemoteText(ref domain.ConnectionRef, name string) (RemoteDocument,error) {
    if err:=validate("remote",name);err!=nil {return RemoteDocument{},err}
    c,err:=m.remote(ref)
    if err!=nil{return RemoteDocument{},err}
    defer c.Close()
    return loadDocument(c,name)
}

func (m *Manager) SaveRemoteText(ref domain.ConnectionRef, name, expectedRevision, content string) (RemoteDocument,error) {
    if err:=protectRoot("remote",name);err!=nil {return RemoteDocument{},err}
    if !utf8.ValidString(content) || strings.ContainsRune(content,0) || int64(len(content))>maxEditSize {
        return RemoteDocument{},errors.New("invalid UTF-8 text or file size exceeds 1 MiB")
    }
    if len(expectedRevision)!=64 {return RemoteDocument{},errors.New("missing valid file revision")}
    c,err:=m.remote(ref)
    if err!=nil{return RemoteDocument{},err}
    defer c.Close()
    original,err:=loadDocument(c,name)
    if err!=nil{return RemoteDocument{},err}
    if original.Revision!=expectedRevision {return RemoteDocument{},errors.New("remote file changed since it was opened; reload before saving")}
    info,err:=c.Stat(name)
    if err!=nil{return RemoteDocument{},err}
    suffix := domain.NewID()
    temp:=name+".openshell-edit-"+suffix+".tmp"
    out,err:=c.OpenFile(temp,os.O_CREATE|os.O_EXCL|os.O_WRONLY)
    if err!=nil{return RemoteDocument{},err}
    defer c.Remove(temp)
    _,writeErr:=io.WriteString(out,content)
    closeErr:=out.Close()
    if writeErr!=nil{return RemoteDocument{},writeErr}
    if closeErr!=nil{return RemoteDocument{},closeErr}
    if err=c.Chmod(temp,info.Mode().Perm());err!=nil{return RemoteDocument{},err}
    // Re-check before atomic replacement. Concurrent edits from the same app
    // are serialized by the caller; unrelated writers may still race the rename.
    current,err:=loadDocument(c,name)
    if err!=nil{return RemoteDocument{},err}
    if current.Revision!=expectedRevision {return RemoteDocument{},errors.New("remote file changed during save")}
    if err=c.PosixRename(temp,name);err!=nil{return RemoteDocument{},fmt.Errorf("atomic replace unsupported or failed: %w",err)}
    digest:=sha256.Sum256([]byte(content))
    return RemoteDocument{Path:name,Content:content,Revision:hex.EncodeToString(digest[:]),Size:int64(len(content))},nil
}

type SyncAction struct {
    Relative string `json:"relative"`
    Source string `json:"source"`
    Destination string `json:"destination"`
    Operation string `json:"operation"`
    Reason string `json:"reason"`
    Size int64 `json:"size"`
}
type SyncPreview struct {
    Direction string `json:"direction"`
    LocalDir string `json:"localDir"`
    RemoteDir string `json:"remoteDir"`
    Actions []SyncAction `json:"actions"`
    Skipped int `json:"skipped"`
    Bytes int64 `json:"bytes"`
}
type syncInfo struct {
    isDir bool
    size int64
    modified time.Time
}

// SyncPreview is deliberately non-destructive. It never proposes deletions.
func (m *Manager) PreviewSync(ref domain.ConnectionRef, direction, localDir, remoteDir string) (SyncPreview,error) {
    if direction!="upload" && direction!="download" {return SyncPreview{},errors.New("unsupported synchronization direction")}
    if err:=validate("local",localDir);err!=nil{return SyncPreview{},err}
    if err:=validate("remote",remoteDir);err!=nil{return SyncPreview{},err}
    c,err:=m.remote(ref)
    if err!=nil{return SyncPreview{},err}
    defer c.Close()
    local,err:=walkLocal(localDir)
    if err!=nil{return SyncPreview{},err}
    remote,err:=walkRemote(c,remoteDir)
    if err!=nil{return SyncPreview{},err}
    source,target:=local,remote
    if direction=="download" {source,target=remote,local}
    result:=SyncPreview{Direction:direction,LocalDir:localDir,RemoteDir:remoteDir,Actions:[]SyncAction{}}
    keys:=make([]string,0,len(source))
    for key:=range source {keys=append(keys,key)}
    sort.Strings(keys)
    for _,key:=range keys {
        info:=source[key]
        if info.isDir {continue}
        current,exists:=target[key]
        act:=SyncAction{Relative:key,Size:info.size,Operation:"copy",Reason:"missing"}
        localPath:=filepath.Join(localDir,filepath.FromSlash(key))
        remotePath:=path.Join(remoteDir,key)
        act.Source,act.Destination=localPath,remotePath
        if direction=="download" {act.Source,act.Destination=remotePath,localPath}
        if exists {
            if current.isDir {act.Operation="conflict";act.Reason="target is a directory"} else if current.size==info.size && absDuration(current.modified.Sub(info.modified))<2*time.Second {
                act.Operation="skip";act.Reason="unchanged"
            }else if current.modified.After(info.modified.Add(2*time.Second)){
                act.Operation="conflict";act.Reason="destination is newer"
            }else{
                act.Reason="changed"
            }
        }
        if act.Operation=="skip" {result.Skipped++;continue}
        if act.Operation=="copy" {result.Bytes+=act.Size}
        result.Actions=append(result.Actions,act)
    }
    return result,nil
}
func absDuration(d time.Duration) time.Duration {if d<0{return -d};return d}

func walkLocal(root string)(map[string]syncInfo,error){
    result:=map[string]syncInfo{}
    err:=filepath.WalkDir(root,func(name string,ent os.DirEntry,walkErr error)error{
        if walkErr!=nil{return walkErr}
        if name==root{return nil}
        if len(result)>=maxSyncEntries{return errors.New("directory sync exceeds 4000 entries")}
        info,err:=ent.Info()
        if err!=nil{return err}
        if info.Mode()&os.ModeSymlink!=0{return filepath.SkipDir}
        rel,err:=filepath.Rel(root,name)
        if err!=nil{return err}
        result[filepath.ToSlash(rel)]=syncInfo{isDir:info.IsDir(),size:info.Size(),modified:info.ModTime()}
        return nil
    })
    return result,err
}
func walkRemote(c *pkg.Client,root string)(map[string]syncInfo,error){
    info,err:=c.Lstat(root)
    if err!=nil{return nil,err}
    if !info.IsDir(){return nil,errors.New("remote synchronization root is not a directory")}
    result:=map[string]syncInfo{}
    var walk func(string,string)error
    walk=func(folder,prefix string)error{
        entries,err:=c.ReadDir(folder)
        if err!=nil{return err}
        for _,entry:=range entries {
            if len(result)>=maxSyncEntries{return errors.New("directory sync exceeds 4000 entries")}
            if entry.Mode()&os.ModeSymlink!=0 {continue}
            rel:=path.Join(prefix,entry.Name())
            result[rel]=syncInfo{isDir:entry.IsDir(),size:entry.Size(),modified:entry.ModTime()}
            if entry.IsDir(){if err=walk(path.Join(folder,entry.Name()),rel);err!=nil{return err}}
        }
        return nil
    }
    if err:=walk(root,"");err!=nil{return nil,err}
    return result,nil
}

func (m *Manager) BatchChmod(ref domain.ConnectionRef, side string, targets []string, mode string) (int,error) {
    if len(targets)==0 || len(targets)>200 {return 0,errors.New("select 1 to 200 files")}
    for _,name:=range targets {if err:=protectRoot(side,name);err!=nil{return 0,err}}
    count:=0
    for _,name:=range targets {
        if err:=m.Operate(ref,side,"chmod",name,mode);err!=nil {
            return count,fmt.Errorf("changed %d files; %s: %w",count,name,err)
        }
        count++
    }
    return count,nil
}
