//go:build windows

package sshclient

import (
	"os/exec"
	"syscall"
)

// Hidden native protocol helper: OpenShell is a GUI process and ZMODEM
// sidecar must never open an unrelated console window.
func configureNativeZmodemSidecar(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow: true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}
