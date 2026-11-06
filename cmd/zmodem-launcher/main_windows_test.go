//go:build windows

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestNativeCommandUsesHiddenConsoleAndPreservesPipes(t *testing.T) {
	parentDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(parentDir, "native"), 0700); err != nil { t.Fatal(err) }
	for _, name := range []string{"rz.exe", "sz.exe"} {
		if err := os.WriteFile(filepath.Join(parentDir, "native", name), []byte("fixture"), 0600); err != nil { t.Fatal(err) }
	}
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

func TestNativeCommandUsesRustWhenLegacyBinariesAreMissing(t *testing.T) {
	parentDir := t.TempDir()
	native := filepath.Join(parentDir, "native")
	if err := os.Mkdir(native, 0700); err != nil { t.Fatal(err) }
	sidecar := filepath.Join(native, "zmodem-sidecar.exe")
	if err := os.WriteFile(sidecar, []byte("fixture"), 0600); err != nil { t.Fatal(err) }
	for _, name := range []string{"rz.exe", "sz.exe"} {
		command, err := nativeCommand(filepath.Join(parentDir, name), []string{"-e", "-b", "-B", "32768"})
		if err != nil { t.Fatal(err) }
		if command.Path != sidecar {
			t.Fatalf("expected native Rust sidecar, got %q", command.Path)
		}
		expected := "compat-rz"
		if name == "sz.exe" { expected = "compat-sz" }
		if !reflect.DeepEqual(command.Args[1:], []string{expected, "-e", "-b", "-B", "32768"}) {
			t.Fatalf("wrong legacy filter arguments: %q", command.Args)
		}
		if command.Stdin != os.Stdin || command.Stdout != os.Stdout || command.Stderr != os.Stderr {
			t.Fatal("Rust compatibility shim lost stdio stream handles")
		}
	}
	if err := os.Remove(sidecar); err != nil { t.Fatal(err) }
	if _, err := nativeCommand(filepath.Join(parentDir, "rz.exe"), nil); err == nil {
		t.Fatal("missing native and legacy helpers must fail closed")
	}
}

func TestNativeCommandRejectsUnexpectedName(t *testing.T) {
	if _, err := nativeCommand("C:\\zmodem\\helper.exe", nil); err == nil {
		t.Fatal("unexpected helper name should fail closed")
	}
}
