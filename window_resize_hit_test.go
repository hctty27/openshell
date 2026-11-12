package main

const (
	nativeHitTestClient      uintptr = 1
	nativeHitTestLeft        uintptr = 10
	nativeHitTestRight       uintptr = 11
	nativeHitTestTop         uintptr = 12
	nativeHitTestTopLeft     uintptr = 13
	nativeHitTestTopRight    uintptr = 14
	nativeHitTestBottom      uintptr = 15
	nativeHitTestBottomLeft  uintptr = 16
	nativeHitTestBottomRight uintptr = 17
)

func cornerOnlyResizeHitTest(hitTest uintptr) uintptr {
	switch hitTest {
	case nativeHitTestTop, nativeHitTestBottom, nativeHitTestLeft, nativeHitTestRight:
		return nativeHitTestClient
	default:
		return hitTest
	}
}
