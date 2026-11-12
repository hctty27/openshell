//go:build !windows

package main

import "unsafe"

func installCornerOnlyResize(unsafe.Pointer) error {
	return nil
}
