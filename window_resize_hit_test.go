package main

import "testing"

func TestCornerOnlyResizeHitTest(t *testing.T) {
	tests := []struct {
		name    string
		hitTest uintptr
		want    uintptr
	}{
		{name: "top edge", hitTest: nativeHitTestTop, want: nativeHitTestClient},
		{name: "bottom edge", hitTest: nativeHitTestBottom, want: nativeHitTestClient},
		{name: "left edge", hitTest: nativeHitTestLeft, want: nativeHitTestClient},
		{name: "right edge", hitTest: nativeHitTestRight, want: nativeHitTestClient},
		{name: "top left corner", hitTest: nativeHitTestTopLeft, want: nativeHitTestTopLeft},
		{name: "top right corner", hitTest: nativeHitTestTopRight, want: nativeHitTestTopRight},
		{name: "bottom left corner", hitTest: nativeHitTestBottomLeft, want: nativeHitTestBottomLeft},
		{name: "bottom right corner", hitTest: nativeHitTestBottomRight, want: nativeHitTestBottomRight},
		{name: "client area", hitTest: nativeHitTestClient, want: nativeHitTestClient},
		{name: "caption", hitTest: 2, want: 2},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := cornerOnlyResizeHitTest(tt.hitTest); got != tt.want {
				t.Fatalf("cornerOnlyResizeHitTest(%d) = %d, want %d", tt.hitTest, got, tt.want)
			}
		})
	}
}
