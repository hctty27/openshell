package sshclient

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/hctty27/openshell/internal/apperror"
	"golang.org/x/crypto/ssh"
)

const nativeZmodemShutdownTimeout = 3 * time.Second

type nativeZmodemLog struct {
	mu sync.Mutex
	data []byte
}

func (l *nativeZmodemLog) Write(p []byte) (int, error) {
	original := len(p)
	l.mu.Lock()
	defer l.mu.Unlock()
	if remaining := 4096 - len(l.data); remaining > 0 {
		if len(p) < remaining { remaining = len(p) }
		l.data = append(l.data, p[:remaining]...)
	}
	return original, nil
}

func (l *nativeZmodemLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return string(bytes.TrimSpace(l.data))
}

// RunNativeZmodemTransport is experimental and is not connected to the
// interactive terminal. Each direction has exactly one reader of binary data.
func RunNativeZmodemTransport(ctx context.Context, client *ssh.Client, sidecar, direction, localPath, remoteCommand string) error {
	if ctx == nil { return apperror.New("zmodemMissingContext", nil) }
	if err := ctx.Err(); err != nil { return err }
	if client == nil || sidecar == "" || localPath == "" || remoteCommand == "" {
		return apperror.New("zmodemBridgeArgumentsIncomplete", nil)
	}
	if direction != "send" && direction != "receive" {
		return apperror.New("zmodemUnsupportedDirectionNamed", map[string]any{"direction": direction})
	}

	// A stalled channel-open reply must not block cancellation indefinitely.
	type openResult struct {
		session *ssh.Session
		err error
	}
	opened := make(chan openResult)
	go func() {
		session, err := client.NewSession()
		select {
		case opened <- openResult{session, err}:
		case <-ctx.Done():
			if session != nil { _ = session.Close() }
		}
	}()
	var session *ssh.Session
	select {
	case result := <-opened:
		if result.err != nil { return result.err }
		session = result.session
	case <-ctx.Done():
		return ctx.Err()
	}
	defer session.Close()

	remoteIn, err := session.StdinPipe()
	if err != nil { return err }
	remoteOut, err := session.StdoutPipe()
	if err != nil { return err }
	if err = nativeZmodemSSHRequest(ctx, session, "Pty", func() error {
		return session.RequestPty("dumb", 24, 80, ssh.TerminalModes{ssh.ECHO: 0})
	}); err != nil { return err }

	process := exec.CommandContext(ctx, sidecar, direction, localPath)
	configureNativeZmodemSidecar(process)
	process.WaitDelay = nativeZmodemShutdownTimeout
	log := &nativeZmodemLog{}
	process.Stderr = log
	localIn, err := process.StdinPipe()
	if err != nil { return err }
	localOut, err := process.StdoutPipe()
	if err != nil { return err }
	if err = nativeZmodemSSHRequest(ctx, session, "Start", func() error {
		return session.Start(remoteCommand)
	}); err != nil { return err }
	if err = process.Start(); err != nil {
		return apperror.Wrap("zmodemSidecarStartFailed", err, nil)
	}
	defer func() {
		if process.Process != nil { _ = process.Process.Kill() }
		_ = session.Close()
	}()

	copied := make(chan error, 2)
	remoteOutputDone := make(chan struct{})
	localOutputDone := make(chan struct{})
	activity := nativeZmodemActivity(ctx)
	go func() {
		defer close(remoteOutputDone)
		_, copyErr := io.Copy(nativeZmodemActivityWriter{target: localIn, touch: activity}, remoteOut)
		_ = localIn.Close()
		copied <- copyErr
	}()
	go func() {
		defer close(localOutputDone)
		_, copyErr := io.Copy(nativeZmodemActivityWriter{target: remoteIn, touch: activity}, localOut)
		_ = remoteIn.Close()
		copied <- copyErr
	}()

	// Wait only after each stdout reader drains, otherwise Wait can close a
	// pipe while its reader is still processing final ZMODEM control frames.
	localFinished := make(chan error, 1)
	remoteFinished := make(chan error, 1)
	go func() { <-localOutputDone; localFinished <- process.Wait() }()
	go func() { <-remoteOutputDone; remoteFinished <- session.Wait() }()
	localDone, remoteDone := false, false
	var localErr, remoteErr error
	for !localDone || !remoteDone {
		select {
		case <-ctx.Done():
			_ = session.Close()
			_ = process.Process.Kill()
			waitForNativeZmodemShutdown(localFinished, remoteFinished, localDone, remoteDone)
			return apperror.Wrap("zmodemCancelledOrIdle", nativeZmodemContextError(ctx), nil)
		case localErr = <-localFinished:
			localDone = true
			localFinished = nil
			if localErr != nil {
				_ = session.Close()
			}
		case remoteErr = <-remoteFinished:
			remoteDone = true
			remoteFinished = nil
			if remoteErr != nil {
				_ = process.Process.Kill()
			}
		}
	}
	if ctx.Err() != nil { return nativeZmodemContextError(ctx) }
	if localErr != nil { return apperror.Wrap("zmodemSidecarProcessFailed", fmt.Errorf("%w; %s", localErr, log.String()), nil) }
	if remoteErr != nil { return apperror.Wrap("zmodemRemoteCommandFailed", remoteErr, nil) }

	for range 2 {
		select {
		case copyErr := <-copied:
			// These close notifications are expected only after both
			// protocol peers have exited successfully.
			if copyErr != nil && !errors.Is(copyErr, io.ErrClosedPipe) &&
				!errors.Is(copyErr, os.ErrClosed) && !errors.Is(copyErr, syscall.EPIPE) {
				return apperror.Wrap("zmodemStreamInterrupted", copyErr, nil)
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}


 // nativeZmodemSSHRequest bounds SSH channel requests that can otherwise
 // wait indefinitely for a remote reply. Closing only this session leaves
 // the user's existing SSH connection and visible terminal untouched.
// nativeZmodemSSHRequestCode names the localized error for a bounded SSH
// request: label is "Pty" (remote PTY allocation) or "Start" (starting the
// remote rz/sz).
func nativeZmodemSSHRequestCode(label string, cancelled bool) string {
	switch {
	case label == "Pty" && cancelled:
		return "zmodemRemotePtyCancelled"
	case label == "Pty":
		return "zmodemRemotePtyFailed"
	case cancelled:
		return "zmodemRemoteStartCancelled"
	}
	return "zmodemRemoteStartFailed"
}

func nativeZmodemSSHRequest(ctx context.Context, session *ssh.Session, label string, request func() error) error {
	result := make(chan error, 1)
	go func() { result <- request() }()
	select {
	case err := <-result:
		if ctxErr := ctx.Err(); ctxErr != nil {
			return apperror.Wrap(nativeZmodemSSHRequestCode(label, true), ctxErr, nil)
		}
		if err != nil { return apperror.Wrap(nativeZmodemSSHRequestCode(label, false), err, nil) }
		return nil
	case <-ctx.Done():
		_ = session.Close()
		return apperror.Wrap(nativeZmodemSSHRequestCode(label, true), ctx.Err(), nil)
	}
}

func waitForNativeZmodemShutdown(local, remote <-chan error, localDone, remoteDone bool) {
	timeout := time.NewTimer(nativeZmodemShutdownTimeout)
	defer timeout.Stop()
	for !localDone || !remoteDone {
		select {
		case <-local:
			localDone = true
			local = nil
		case <-remote:
			remoteDone = true
			remote = nil
		case <-timeout.C:
			return
		}
	}
}
