package sshclient

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"

	"github.com/hctty27/openshell/internal/apperror"
)

func TestFriendlyConnectErrorMapsCommonFailures(t *testing.T) {
	cases := map[string]error{
		"sshAuthRejected":          errors.New("ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password], no supported methods remain"),
		"sshConnectionRefused":     errors.New("dial tcp 127.0.0.1:2299: connect: connection refused"),
		"sshConnectTimedOut":       errors.New("dial tcp 10.1.1.1:22: i/o timeout"),
		"sshHostNotFound":          errors.New("dial tcp: lookup nope.invalid: no such host"),
		"sshHostUnreachable":       errors.New("dial tcp 10.0.0.1:22: connect: no route to host"),
		"sshServerClosedHandshake": fmt.Errorf("ssh: handshake failed: %w", io.EOF),
		"sshConnect":               errors.New("something unexpected"),
	}
	for code, input := range cases {
		got := FriendlyConnectError(input)
		if got == nil || !strings.Contains(got.Error(), `"code":"`+code+`"`) {
			t.Errorf("%v -> %v, want %s", input, got, code)
		}
		if code != "sshConnect" && strings.Contains(got.Error(), "detail") {
			t.Errorf("%s should not leak the raw Go error: %v", code, got)
		}
	}
	kept := apperror.New("privateKeyInvalid", nil)
	if FriendlyConnectError(kept) != kept {
		t.Fatal("coded errors must pass through unchanged")
	}
	if FriendlyConnectError(nil) != nil {
		t.Fatal("nil must stay nil")
	}
}
