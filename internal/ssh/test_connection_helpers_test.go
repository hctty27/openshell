package sshclient

import (
 "context"
 "errors"
 "testing"

 "github.com/hctty27/openshell/internal/domain"
 "github.com/hctty27/openshell/internal/testssh"
)

func connected(t *testing.T) (*Manager, domain.ConnectionRef) {
	s := testssh.Start(t)
	m := NewManager(keys{}, nil)
	t.Cleanup(m.Close)
	row := domain.Session{ID: "a", Host: s.Host, Port: s.Port, Username: "root"}
	_, e := m.Connect(context.Background(), "tab", row, AuthInput{Password: "test-password"})
	var h *HostKeyError
	errors.As(e, &h)
	m.keys.Trust(h.Address, h.Key)
	ref, e := m.Connect(context.Background(), "tab", row, AuthInput{Password: "test-password"})
	if e != nil {
		t.Fatal(e)
	}
	return m, ref
}
