//go:build windows

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestNativeCommandUsesRustOnlyAndPreservesStreams(t *testing.T) {
	parentDir := t.TempDir()
	native := filepath.Join(parentDir, "native")
	if err := os.Mkdir(native, 0700); err != nil { t.Fatal(err) }
	sidecar := filepath.Join(native, "zmodem-sidecar.exe")
	if err := os.WriteFile(sidecar, []byte("fixture"), 0600); err != nil { t.Fatal(err) }

	// Old DLL and lrzsz binaries left by a previous installation must never
	// override the Rust engine, even when compatibility mode is selected.
	for _, name := range []string{"rz.exe", "sz.exe", "msys-2.0.dll"} {
		if err := os.WriteFile(filepath.Join(native, name), []byte("legacy"), 0600); err != nil { t.Fatal(err) }
	}
	for _, name := range []string{"rz.exe", "sz.exe"} {
		t.Run(name, func(t *testing.T) {
			args := []string{"-e", "-b", "-B", "32768", "filename with spaces.bin"}
			cmd, err := nativeCommand(filepath.Join(parentDir, name), args)
			if err != nil { t.Fatal(err) }
			if cmd.Path != sidecar { t.Fatalf("wrong backend: %q", cmd.Path) }
			action := "compat-rz"
			if name == "sz.exe" { action = "compat-sz" }
			if !reflect.DeepEqual(cmd.Args[1:], append([]string{action}, args...)) {
				t.Fatalf("unexpected Rust CLI args: %v", cmd.Args)
			}
			if cmd.Stdin != os.Stdin || cmd.Stdout != os.Stdout || cmd.Stderr != os.Stderr {
				t.Fatal("stdin/stdout/stderr not inherited")
			}
			if cmd.Dir != "" { t.Fatalf("cwd must be inherited: %q", cmd.Dir) }
			if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow ||
				cmd.SysProcAttr.CreationFlags&createNoWindow == 0 {
				t.Fatal("launcher must not create a console")
			}
		})
	}
	if err := os.Remove(sidecar); err != nil { t.Fatal(err) }
	if _, err := nativeCommand(filepath.Join(parentDir, "rz.exe"), nil); err == nil {
		t.Fatal("must not fall back to legacy lrzsz if Rust sidecar is unavailable")
	}
}
func TestNativeCommandRejectsUnexpectedName(t *testing.T) {
	if _, err := nativeCommand("C:\\zmodem\\helper.exe", nil); err == nil {
		t.Fatal("unexpected helper name should fail closed")
	}
}
