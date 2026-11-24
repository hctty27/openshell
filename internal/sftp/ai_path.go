package sftp

import (
    "errors"
    "os"
    "path"
    "strings"

    "github.com/hctty27/openshell/internal/domain"
)

// AIResolveRemotePath resolves a remote path before the AI approval decision.
// The result must be used for the subsequent operation instead of the
// user-provided alias. Reject ambiguous server replies and paths involving
// ".." or a still-unresolved symbolic link.
func (m *Manager) AIResolveRemotePath(ref domain.ConnectionRef, name string) (resolved string, followedLink bool, err error) {
    if err = validate("remote", name); err != nil { return "", false, err }
    for _, part := range strings.Split(name, "/") {
        if part == ".." {
            return "", false, errors.New("AI SFTP path must not contain ..; provide a direct absolute path")
        }
    }
    c, release, err := m.borrowRemote(ref)
    if err != nil { return "", false, err }
    defer release()

    check := func(name string) (bool, error) {
        if name == "/" { return false, nil }
        current := ""
        linked := false
        for _, segment := range strings.Split(strings.TrimPrefix(path.Clean(name), "/"), "/") {
            current += "/" + segment
            info, statErr := c.Lstat(current)
            if statErr != nil { return false, statErr }
            if info.Mode() & os.ModeSymlink != 0 { linked = true }
        }
        return linked, nil
    }
    linked, err := check(name)
    if err != nil { return "", false, err }

    canonical, err := c.RealPath(name)
    if err != nil { return "", false, err }
    if !path.IsAbs(canonical) || strings.ContainsRune(canonical, 0) {
        return "", false, errors.New("AI SFTP server returned an unsafe canonical path")
    }
    canonical = path.Clean(canonical)
    // Some SFTP servers canonicalize '..' but do not resolve symlinks.
    // In that case using their answer would still permit a sensitive-path bypass.
    if linked && canonical == path.Clean(name) {
        return "", false, errors.New("AI SFTP cannot verify the symbolic link target; use the direct absolute path")
    }
    unresolved, err := check(canonical)
    if err != nil { return "", false, err }
    if unresolved {
        return "", false, errors.New("AI SFTP canonical path still contains symbolic links; use the direct absolute path")
    }
    return canonical, linked, nil
}
