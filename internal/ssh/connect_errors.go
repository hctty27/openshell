package sshclient

import (
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"syscall"

	"github.com/hctty27/openshell/internal/apperror"
)

// FriendlyConnectError turns a raw dial or handshake error from the Go SSH
// stack ("ssh: handshake failed: ssh: unable to authenticate, attempted
// methods [none password], no supported methods remain") into one coded,
// localizable message. Errors that already carry a code are kept as is, and
// anything unrecognized keeps the raw text as detail for diagnosis.
func FriendlyConnectError(err error) error {
	if err == nil {
		return nil
	}
	var coded *apperror.Error
	if errors.As(err, &coded) {
		return err
	}
	text := strings.ToLower(err.Error())
	var dnsErr *net.DNSError
	switch {
	case strings.Contains(text, "unable to authenticate") || strings.Contains(text, "no supported methods remain"):
		return apperror.New("sshAuthRejected", nil)
	case errors.As(err, &dnsErr) && dnsErr.IsNotFound, strings.Contains(text, "no such host"):
		return apperror.New("sshHostNotFound", nil)
	case errors.Is(err, syscall.ECONNREFUSED) || strings.Contains(text, "connection refused") || strings.Contains(text, "actively refused"):
		return apperror.New("sshConnectionRefused", nil)
	case errors.Is(err, context.DeadlineExceeded) || strings.Contains(text, "i/o timeout") || strings.Contains(text, "timed out"):
		return apperror.New("sshConnectTimedOut", nil)
	case errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.EHOSTUNREACH) ||
		strings.Contains(text, "network is unreachable") || strings.Contains(text, "no route to host"):
		return apperror.New("sshHostUnreachable", nil)
	case strings.Contains(text, "handshake failed") && (errors.Is(err, io.EOF) || strings.HasSuffix(text, ": eof") ||
		strings.Contains(text, "connection reset")):
		return apperror.New("sshServerClosedHandshake", nil)
	}
	return apperror.Wrap("sshConnect", err, nil)
}
