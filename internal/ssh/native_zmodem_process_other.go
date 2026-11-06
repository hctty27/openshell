//go:build !windows

package sshclient

import "os/exec"

func configureNativeZmodemSidecar(*exec.Cmd) {}
