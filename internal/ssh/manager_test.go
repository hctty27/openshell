package sshclient

import (
	"context"
	"errors"
	"fmt"
	"github.com/hctty27/openshell/internal/domain"
	"github.com/hctty27/openshell/internal/testssh"
	"testing"
)

type keys map[string][]byte

func (k keys) Lookup(h string) ([]byte, error) { return k[h], nil }
func (k keys) Trust(h string, b []byte) error  { k[h] = b; return nil }
func TestHostKeyTrust(t *testing.T) {
	s := testssh.Start(t)
	k := keys{}
	m := NewManager(k, nil)
	defer m.Close()
	session := domain.Session{ID: "s", Host: s.Host, Port: s.Port, Username: "root", AuthType: "password"}
	_, e := m.Connect(context.Background(), "a", session, AuthInput{Password: "test-password"})
	var challenge *HostKeyError
	if !errors.As(e, &challenge) || challenge.Changed {
		t.Fatalf("expected first-use challenge: %v", e)
	}
	if e = k.Trust(challenge.Address, challenge.Key); e != nil {
		t.Fatal(e)
	}
	ref, e := m.Connect(context.Background(), "a", session, AuthInput{Password: "test-password"})
	if e != nil {
		t.Fatal(e)
	}
	if ref.Generation == 0 {
		t.Fatal(ref)
	}
	k[challenge.Address] = []byte("other key")
	_, e = m.Connect(context.Background(), "b", session, AuthInput{Password: "test-password"})
	if !errors.As(e, &challenge) || !challenge.Changed {
		t.Fatalf("expected changed key: %v", e)
	}
}
func TestStaleGeneration(t *testing.T) {
	s := testssh.Start(t)
	k := keys{}
	m := NewManager(k, nil)
	defer m.Close()
	session := domain.Session{ID: "s", Host: s.Host, Port: s.Port, Username: "root"}
	_, e := m.Connect(context.Background(), "a", session, AuthInput{Password: "test-password"})
	var h *HostKeyError
	errors.As(e, &h)
	k.Trust(h.Address, h.Key)
	a, e := m.Connect(context.Background(), "a", session, AuthInput{Password: "test-password"})
	if e != nil {
		t.Fatal(e)
	}
	b, e := m.Connect(context.Background(), "a", session, AuthInput{Password: "test-password"})
	if e != nil {
		t.Fatal(e)
	}
	if b.Generation <= a.Generation {
		t.Fatal("generation did not advance")
	}
	if _, e = m.OpenSession(a); e == nil {
		t.Fatal("stale reference accepted")
	}
}
func TestIPv6Address(t *testing.T) {
	if Address("::1", 22) != "[::1]:22" {
		t.Fatal(Address("::1", 22))
	}
	_ = fmt.Sprint(1)
}
func TestTerminalUTF8Chunks(t *testing.T) {
	b := NewHistory(12)
	b.Write([]byte("你好世界"))
	b.Write([]byte("！"))
	if got := b.Text(200, 32768); got != "好世界！" {
		t.Fatalf("%q", got)
	}
}
