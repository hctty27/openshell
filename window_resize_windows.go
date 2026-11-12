//go:build windows

package main

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

const (
	wmNCDestroy = 0x0082
	wmNCHitTest = 0x0084

	cornerOnlyResizeSubclassID = uintptr(0x4F534852)
)

var (
	commonControls              = syscall.NewLazyDLL("comctl32.dll")
	setWindowSubclassProc       = commonControls.NewProc("SetWindowSubclass")
	removeWindowSubclassProc    = commonControls.NewProc("RemoveWindowSubclass")
	defSubclassProc             = commonControls.NewProc("DefSubclassProc")
	cornerOnlyResizeCallback    = syscall.NewCallback(cornerOnlyResizeSubclassProc)
)

func installCornerOnlyResize(hwnd unsafe.Pointer) error {
	if hwnd == nil {
		return errors.New("cannot install corner-only resize handling on a nil window")
	}

	result, _, callErr := setWindowSubclassProc.Call(
		uintptr(hwnd),
		cornerOnlyResizeCallback,
		cornerOnlyResizeSubclassID,
		0,
	)
	if result != 0 {
		return nil
	}
	if callErr == syscall.Errno(0) {
		return errors.New("SetWindowSubclass returned FALSE")
	}
	return fmt.Errorf("SetWindowSubclass failed: %w", callErr)
}

func cornerOnlyResizeSubclassProc(hwnd uintptr, message uint32, wParam, lParam uintptr, subclassID uintptr, _ uintptr) uintptr {
	if message == wmNCDestroy {
		removeWindowSubclassProc.Call(hwnd, cornerOnlyResizeCallback, subclassID)
	}

	result, _, _ := defSubclassProc.Call(hwnd, uintptr(message), wParam, lParam)
	if message == wmNCHitTest {
		return cornerOnlyResizeHitTest(result)
	}
	return result
}
