//go:build windows

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestNativeCommandUsesHiddenConsoleAndPreservesPipes(t *testing.T) {
	parentDir := filepath.Join("C:", "OpenShell", "zmodem")
	for _, name := range []string{"rz.exe", "sz.exe"} {
		t.Run(name, func(t *testing.T) {
			args := []string{"-e", "-b", "filename with spaces.bin"}
			cmd, err := nativeCommand(filepath.Join(parentDir, name), args)
			if err != nil {
				t.Fatal(err)
			}
			if expected := filepath.Join(parentDir, "native", name); cmd.Path != expected {
				t.Fatalf("child path %q, want %q", cmd.Path, expected)
			}
			if !reflect.DeepEqual(cmd.Args[1:], args) {
				t.Fatalf("arguments changed: %#v", cmd.Args)
			}
			if cmd.Stdin != os.Stdin || cmd.Stdout != os.Stdout || cmd.Stderr != os.Stderr {
				t.Fatal("stdio was not preserved")
			}
			if cmd.Dir != "" {
				t.Fatalf("working directory %q should be inherited", cmd.Dir)
			}
			if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow ||
				cmd.SysProcAttr.CreationFlags&createNoWindow == 0 {
				t.Fatal("native process must be launched without a console window")
			}
		})
	}
}

func TestNativeCommandRejectsUnexpectedName(t *testing.T) {
	if _, err := nativeCommand("C:\\zmodem\\helper.exe", nil); err == nil {
		t.Fatal("unexpected helper name should fail closed")
	}
}
