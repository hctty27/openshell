package sshclient

import (
    "fmt"
    "io"
    "os"
    "path/filepath"
    "strconv"
    "time"

    "github.com/hctty27/openshell/internal/domain"
    "github.com/trzsz/trzsz-go/trzsz"
)

type zmodemSelection struct {
    id uint64
    direction string
    allowDirectories bool
    response chan []string
}

const zmodemSelectionTimeout = 5 * time.Minute

var zmodemCancelSequence = []byte("\x18\x18\x18\x18\x18\x18\x18\x18\x18\x18\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08")

// selectZmodemPaths pauses the remote ZMODEM header until the in-app picker
// supplies validated local paths. No native operating-system dialog is opened.
func (m *Manager) selectZmodemPaths(c *connection, direction, protocol string, allowDirectories bool, filter *trzsz.TrzszFilter, serverIn io.Writer) bool {
    m.mu.Lock()
    if m.connections[c.ref.TabID] != c {
        m.mu.Unlock()
        return false
    }
    if c.zmodemSelection != nil || c.transferring {
        m.mu.Unlock()
        return true
    }
    m.nextZmodemSelectionID++
    request := &zmodemSelection{
        id: m.nextZmodemSelectionID,
        direction: direction,
        allowDirectories: allowDirectories,
        response: make(chan []string, 1),
    }
    c.zmodemSelection = request
    ref := c.ref
    m.mu.Unlock()

    m.emit("ssh:zmodem-pick", map[string]any{
        "ref": ref, "id": request.id, "direction": direction,
        "protocol": protocol, "allowDirectories": allowDirectories,
    })

    var paths []string
    select {
    case paths = <-request.response:
    case <-time.After(zmodemSelectionTimeout):
    }

    m.mu.Lock()
    live := m.connections[ref.TabID] == c && c.ref == ref
    if c.zmodemSelection == request {
        c.zmodemSelection = nil
    } else {
        live = false
    }
    m.mu.Unlock()

    m.emit("ssh:zmodem-pick-ended", map[string]any{"ref": ref, "id": request.id})
    if !live || len(paths) == 0 {
        if live {
            if protocol == "trzsz" {
                _, _ = serverIn.Write([]byte{0x03})
                m.emit("ssh:transfer-finished", map[string]any{"ref": ref})
            } else {
                _, _ = serverIn.Write(zmodemCancelSequence)
            }
        }
        return false
    }

    var err error
    if direction == "upload" {
        _, err = filter.OneTimeUpload(paths)
    } else {
        err = filter.SetDefaultDownloadPath(paths[0])
    }
    if err != nil {
        m.emit("ssh:zmodem-pick-error", map[string]any{"ref": ref, "id": request.id, "error": err.Error()})
        if protocol == "trzsz" {
            _, _ = serverIn.Write([]byte{0x03})
        } else {
            _, _ = serverIn.Write(zmodemCancelSequence)
        }
        return false
    }

    m.mu.Lock()
    if m.connections[ref.TabID] != c || c.ref != ref {
        m.mu.Unlock()
        return false
    }
    c.transferID = request.id
    c.transferProtocol = protocol
    c.transferDirection = direction
    c.transferCancelled = false
    m.mu.Unlock()

    files := []map[string]any{}
    if protocol == "zmodem" {
        files = zmodemSelectedFiles(paths)
    }
    m.emit("ssh:transfer-details", map[string]any{
        "ref": ref,
        "transferId": strconv.FormatUint(request.id, 10),
        "direction": direction,
        "protocol": protocol,
        "files": files,
    })
    return true
}

func zmodemSelectedFiles(paths []string) []map[string]any {
    files := make([]map[string]any, 0, len(paths))
    for _, path := range paths {
        info, err := os.Stat(path)
        if err != nil || !info.Mode().IsRegular() || info.Size() < 0 {
            continue
        }
        files = append(files, map[string]any{
            "name": filepath.Base(path),
            "total": info.Size(),
        })
    }
    return files
}

// SubmitZmodemSelection accepts only a current request on its original SSH
// connection. An empty path list explicitly cancels the remote transfer.
func (m *Manager) SubmitZmodemSelection(ref domain.ConnectionRef, id uint64, paths []string) error {
    m.mu.Lock()
    c := m.connections[ref.TabID]
    if c == nil || c.ref != ref || c.zmodemSelection == nil || c.zmodemSelection.id != id {
        m.mu.Unlock()
        return fmt.Errorf("ZMODEM selection has expired")
    }
    request := c.zmodemSelection
    direction := request.direction
    allowDirectories := request.allowDirectories
    m.mu.Unlock()

    if len(paths) > 0 {
        if direction == "download" && len(paths) != 1 {
            return fmt.Errorf("select one directory for ZMODEM download")
        }
        if len(paths) > 100 {
            return fmt.Errorf("too many ZMODEM upload files")
        }
        for _, path := range paths {
            if !filepath.IsAbs(path) {
                return fmt.Errorf("local file path must be absolute")
            }
            info, err := os.Stat(path)
            if err != nil {
                return err
            }
            if direction == "download" && !info.IsDir() {
                return fmt.Errorf("ZMODEM download destination must be a directory")
            }
            if direction == "upload" && !info.Mode().IsRegular() && !(allowDirectories && info.IsDir()) {
                return fmt.Errorf("upload requires regular files unless directory mode is enabled")
            }
        }
    }

    m.mu.Lock()
    defer m.mu.Unlock()
    if m.connections[ref.TabID] != c || c.zmodemSelection != request {
        return fmt.Errorf("ZMODEM selection has expired")
    }
    select {
    case request.response <- append([]string(nil), paths...):
        return nil
    default:
        return fmt.Errorf("ZMODEM selection already submitted")
    }
}

func releaseZmodemSelection(c *connection) {
    if c.zmodemSelection == nil {
        return
    }
    select {
    case c.zmodemSelection.response <- nil:
    default:
    }
}
