package sshclient

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func TestNativeZmodemIdleWatchdogCancelsUnresponsivePeer(t *testing.T) {
	ctx, stop, _ := newNativeZmodemIdleContext(context.Background(), 60*time.Millisecond)
	defer stop()
	select {
	case <-ctx.Done():
		if !errors.Is(nativeZmodemContextError(ctx), errNativeZmodemIdleTimeout) {
			t.Fatalf("wrong idle timeout cause: %v", context.Cause(ctx))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stalled transfer was not cancelled")
	}
}

func TestNativeZmodemIdleWatchdogAllowsProgressLongerThanWindow(t *testing.T) {
	ctx, stop, touch := newNativeZmodemIdleContext(context.Background(), 250*time.Millisecond)
	defer stop()
	for i := 0; i < 6; i++ {
		time.Sleep(65 * time.Millisecond)
		touch()
		select {
		case <-ctx.Done():
			t.Fatalf("active transfer was cancelled at heartbeat %d: %v", i, context.Cause(ctx))
		default:
		}
	}
}

func TestNativeZmodemIdleWatchdogPreservesParentCancel(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	ctx, stop, touch := newNativeZmodemIdleContext(parent, time.Minute)
	defer stop()
	touch()
	cancelParent()
	select {
	case <-ctx.Done():
		if !errors.Is(nativeZmodemContextError(ctx), context.Canceled) {
			t.Fatalf("parent cancellation was lost: %v", nativeZmodemContextError(ctx))
		}
	case <-time.After(time.Second):
		t.Fatal("parent cancel did not propagate")
	}
}

func TestNativeZmodemActivityWriterRecordsSuccessfulBytesOnly(t *testing.T) {
	ctx, stop, touch := newNativeZmodemIdleContext(context.Background(), time.Second)
	defer stop()
	var output strings.Builder
	writer := nativeZmodemActivityWriter{target: &output, touch: touch}
	if _, err := io.Copy(writer, strings.NewReader("protocol data")); err != nil { t.Fatal(err) }
	if got := output.String(); got != "protocol data" { t.Fatalf("output changed: %q", got) }
	if nativeZmodemActivity(ctx) == nil { t.Fatal("missing scoped activity observer") }
}

func TestNativeZmodemLargeFileCompatibilityBounds(t *testing.T) {
	if nativeZmodemMaxFileSize <= 1024*1024*1024 {
		t.Fatal("1 GiB file should be within the native compatibility limit")
	}
	if nativeZmodemMaxFileSize != (2<<30)-1 {
		t.Fatalf("unexpected limit: %d", nativeZmodemMaxFileSize)
	}
}
