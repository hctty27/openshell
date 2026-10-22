package sftp

import (
    "crypto/sha256"
    "encoding/hex"
    "errors"
    "fmt"
    "io"
    "os"
    "path"
    "strings"
    "unicode/utf8"

    "github.com/hctty27/openshell/internal/domain"
)

const aiReadLimit int64 = 24 * 1024

// AIExcerpt is explicitly requested content, not a shell instruction.
type AIExcerpt struct {
    Path string `json:"path"`
    Content string `json:"content"`
    Revision string `json:"revision"`
    Truncated bool `json:"truncated"`
}

func safeForAI(name string) bool {
    base:=strings.ToLower(path.Base(name))
    switch base {
    case ".env",".netrc","id_rsa","id_ed25519","authorized_keys","known_hosts","credentials","credentials.json":
        return false
    }
    for _,suffix:=range []string{".pem",".p12",".pfx",".key",".kdbx"} {
        if strings.HasSuffix(base,suffix) {return false}
    }
    return true
}

// ReadAIExcerpt never follows a symlink. For logs only the last bounded bytes
// are sent; proposals require the entire file to fit in the limit.
func (m *Manager) ReadAIExcerpt(ref domain.ConnectionRef, name string, tail, complete bool) (AIExcerpt,error) {
    if err:=validate("remote",name);err!=nil {return AIExcerpt{},err}
    if !safeForAI(name) {return AIExcerpt{},errors.New("credential and private-key files cannot be sent to AI")}
    c,err:=m.remote(ref)
    if err!=nil {return AIExcerpt{},err}
    defer c.Close()
    info,err:=c.Lstat(name)
    if err!=nil {return AIExcerpt{},err}
    if !info.Mode().IsRegular() {return AIExcerpt{},errors.New("AI can only read regular files")}
    if complete && info.Size()>aiReadLimit {
        return AIExcerpt{},fmt.Errorf("AI proposed edits require files under %d KiB",aiReadLimit/1024)
    }
    file,err:=c.Open(name)
    if err!=nil{return AIExcerpt{},err}
    defer file.Close()
    offset:=int64(0)
    if tail && info.Size()>aiReadLimit {
        offset=info.Size()-aiReadLimit
        if _,err=file.Seek(offset,io.SeekStart);err!=nil{return AIExcerpt{},err}
    }
    data,err:=io.ReadAll(io.LimitReader(file,aiReadLimit+1))
    if err!=nil{return AIExcerpt{},err}
    truncated:=offset>0 || int64(len(data))>aiReadLimit
    if int64(len(data))>aiReadLimit{data=data[:aiReadLimit]}
    if offset>0 {
        if at:=strings.IndexByte(string(data),'\n');at>=0{data=data[at+1:]}
    }
    if !utf8.Valid(data) || strings.IndexByte(string(data),0)>=0 {
        return AIExcerpt{},errors.New("binary or invalid UTF-8 file cannot be sent to AI")
    }
    if complete && truncated{return AIExcerpt{},errors.New("refusing to propose edits for truncated files")}
    digest:=sha256.Sum256(data)
    return AIExcerpt{Path:name,Content:string(data),Revision:hex.EncodeToString(digest[:]),Truncated:truncated},nil
}

func (m *Manager) AILocalFileName(ref domain.ConnectionRef, file string) (string,error) {
    if err:=validate("local",file);err!=nil{return "",err}
    if _,err:=m.lookup(ref);err!=nil{return "",err}
    info,err:=os.Lstat(file)
    if err!=nil{return "",err}
    if !info.Mode().IsRegular(){return "",errors.New("AI upload planning requires one regular local file")}
    if !safeForAI(info.Name()){return "",errors.New("credential and private-key files cannot be sent to AI")}
    return info.Name(),nil
}
