package sftp

import (
    "errors"
    "fmt"
    "os"
    "path"
    "path/filepath"
    "sort"
    "strconv"
    "strings"
    "sync"

    "github.com/hctty27/openshell/internal/domain"
    pkg "github.com/pkg/sftp"
    "golang.org/x/crypto/ssh"
)

type Entry struct {
    Name string `json:"name"`
    Path string `json:"path"`
    IsDir bool `json:"isDir"`
    IsSymlink bool `json:"isSymlink"`
    Size int64 `json:"size"`
    Modified int64 `json:"modified"`
    Mode string `json:"mode"`
}
type Paths struct {
    Local string `json:"local"`
    Remote string `json:"remote"`
}
type Lookup func(domain.ConnectionRef) (*ssh.Client, error)

type Manager struct {
    lookup Lookup
    emit func(string, any)
    mu sync.Mutex
    tasks map[string]*job
    slots map[string]chan struct{}
    closed bool
}

func NewManager(lookup Lookup, emit func(string, any)) *Manager {
    return &Manager{lookup: lookup, emit: emit, tasks: make(map[string]*job), slots: make(map[string]chan struct{})}
}

func (m *Manager) remote(ref domain.ConnectionRef) (*pkg.Client, error) {
    transport, err := m.lookup(ref)
    if err != nil { return nil, err }
    return pkg.NewClient(transport)
}

func validate(side, name string) error {
    if strings.IndexByte(name, 0) >= 0 { return errors.New("invalid file path") }
    switch side {
    case "local":
        if !filepath.IsAbs(name) { return errors.New("local path must be absolute") }
    case "remote":
        if !path.IsAbs(name) { return errors.New("remote path must be absolute") }
    default:
        return errors.New("invalid file location")
    }
    return nil
}
func protectRoot(side, name string) error {
    if err := validate(side, name); err != nil { return err }
    if side == "remote" && path.Clean(name) == "/" { return errors.New("root directory cannot be modified") }
    if side == "local" && filepath.Dir(filepath.Clean(name)) == filepath.Clean(name) {
        return errors.New("volume root cannot be modified")
    }
    return nil
}
func makeEntry(dir string, info os.FileInfo, remote bool) Entry {
    name := filepath.Join(dir, info.Name())
    if remote { name = path.Join(dir, info.Name()) }
    return Entry{
        Name: info.Name(), Path: name, IsDir: info.IsDir(),
        IsSymlink: info.Mode()&os.ModeSymlink != 0,
        Size: info.Size(), Modified: info.ModTime().UnixMilli(),
        Mode: fmt.Sprintf("%04o", info.Mode().Perm()),
    }
}
func (m *Manager) Homes(ref domain.ConnectionRef) (Paths, error) {
    home, err := os.UserHomeDir()
    if err != nil { return Paths{}, err }
    c, err := m.remote(ref)
    if err != nil { return Paths{}, err }
    defer c.Close()
    remoteHome, err := c.Getwd()
    if err != nil { return Paths{}, err }
    return Paths{Local: home, Remote: remoteHome}, nil
}
func (m *Manager) List(ref domain.ConnectionRef, side, directory string) ([]Entry, error) {
    if err := validate(side, directory); err != nil { return nil, err }
    if _, err := m.lookup(ref); err != nil { return nil, err }
    var infos []os.FileInfo
    if side == "local" {
        entries, err := os.ReadDir(directory)
        if err != nil { return nil, err }
        infos = make([]os.FileInfo, 0, len(entries))
        for _, ent := range entries {
            info, err := ent.Info()
            if err != nil { return nil, err }
            infos = append(infos, info)
        }
    } else {
        c, err := m.remote(ref)
        if err != nil { return nil, err }
        defer c.Close()
        infos, err = c.ReadDir(directory)
        if err != nil { return nil, err }
    }
    out := make([]Entry, 0, len(infos))
    for _, info := range infos { out = append(out, makeEntry(directory, info, side == "remote")) }
    sort.Slice(out, func(i,j int) bool {
        if out[i].IsDir != out[j].IsDir { return out[i].IsDir }
        return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
    })
    return out, nil
}

func checkNotExists(check func(string) (os.FileInfo, error), target string) error {
    _, err := check(target)
    if err == nil { return os.ErrExist }
    if errors.Is(err, os.ErrNotExist) { return nil }
    return err
}
func (m *Manager) Operate(ref domain.ConnectionRef, side, operation, source, argument string) error {
    if err := validate(side, source); err != nil { return err }
    if _, err := m.lookup(ref); err != nil { return err }
    if operation == "delete" || operation == "rename" {
        if err := protectRoot(side, source); err != nil { return err }
    }
    if operation == "rename" {
        if err := protectRoot(side, argument); err != nil { return err }
        if source == argument { return errors.New("source and target are identical") }
    }
    var perms os.FileMode
    if operation == "chmod" {
        n, err := strconv.ParseUint(argument, 8, 16)
        if err != nil || n > 0777 { return errors.New("invalid octal file permission") }
        perms = os.FileMode(n)
    }
    if side == "local" {
        switch operation {
        case "mkdir": return os.Mkdir(source, 0755)
        case "rename":
            if err := checkNotExists(os.Lstat, argument); err != nil { return err }
            return os.Rename(source, argument)
        case "delete": return os.RemoveAll(source)
        case "chmod": return os.Chmod(source, perms)
        default: return errors.New("unsupported file operation")
        }
    }
    c, err := m.remote(ref)
    if err != nil { return err }
    defer c.Close()
    switch operation {
    case "mkdir": return c.Mkdir(source)
    case "rename":
        if err := checkNotExists(c.Lstat, argument); err != nil { return err }
        return c.Rename(source, argument)
    case "delete": return c.RemoveAll(source)
    case "chmod": return c.Chmod(source, perms)
    default: return errors.New("unsupported file operation")
    }
}
