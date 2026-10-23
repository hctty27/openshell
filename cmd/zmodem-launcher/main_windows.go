//go:build windows

// The Windows GUI subsystem avoids creating a console for the launcher.
// The original, unmodified lrzsz binaries live in the sibling native folder.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

const createNoWindow = 0x08000000

func nativeCommand(executable string, arguments []string) (*exec.Cmd, error) {
	name := strings.ToLower(filepath.Base(executable))
	if name != "rz.exe" && name != "sz.exe" {
		return nil, fmt.Errorf("unsupported ZMODEM helper %q", name)
	}

	path := filepath.Join(filepath.Dir(executable), "native", name)
	command := exec.Command(path, arguments...)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
	// Leave Dir empty: trzsz-go sets the upload/download directory on
	// the launcher, and the native process must inherit that directory.
	return command, nil
}

func main() {
	executable, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "OpenShell ZMODEM launcher:", err)
		os.Exit(1)
	}

	command, err := nativeCommand(executable, os.Args[1:])
	if err == nil {
		err = command.Run()
	}
	if err == nil {
		return
	}

	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		os.Exit(exitError.ExitCode())
	}
	fmt.Fprintln(os.Stderr, "OpenShell ZMODEM launcher:", err)
	os.Exit(1)
}
