//go:build windows

package main

import (
    "errors"
    "os"
    "os/exec"
    "path/filepath"
    "strings"

    "github.com/UserExistsError/conpty"
)

func newLocalPTY(shell string, cols, rows int) (localPTY, error) {
    systemRoot := os.Getenv("SystemRoot")
    if systemRoot == "" { systemRoot = "C:\\Windows" }
    var path string
    switch shell {
    case "powershell":
        path = filepath.Join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    case "cmd":
        path = filepath.Join(systemRoot, "System32", "cmd.exe")
    case "pwsh", "wsl":
        name := shell + ".exe"
        var err error
        path, err = exec.LookPath(name)
        if err != nil { return nil, err }
    default:
        return nil, errors.New("unsupported local shell")
    }
    command := `"` + strings.ReplaceAll(path, `"`, "") + `"`
    options := []conpty.ConPtyOption{conpty.ConPtyDimensions(cols, rows)}
    if home, err := os.UserHomeDir(); err == nil && home != "" {
        options = append(options, conpty.ConPtyWorkDir(home))
    }
    return conpty.Start(command, options...)
}
