package main

import (
	"context"
	"github.com/hctty27/openshell/internal/domain"
	"github.com/hctty27/openshell/internal/testssh"
	"net"
	"path/filepath"
	"testing"
	"time"
)

func TestEditingConnectedSessionKeepsLiveSshTarget(t *testing.T) {
	a, err := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.shutdown(context.Background())
	server := testssh.Start(t)
	row, err := a.SaveSession(SaveSessionRequest{
		Session: domain.Session{Name: "Original", Host: server.Host, Port: server.Port, Username: "root", AuthType: "password"},
		Secret:  "test-password", SaveSecret: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := a.Connect("tab", row.ID, "")
	if err != nil || first.Challenge == nil {
		t.Fatal(first, err)
	}
	if err = a.TrustHost(first.Challenge.ID); err != nil {
		t.Fatal(err)
	}
	connected, err := a.Connect("tab", row.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	row.Name, row.Host, row.Port, row.Username = "Updated", "new.example", 2222, "deploy"
	saved, err := a.SaveSession(SaveSessionRequest{Session: row, SaveSecret: true})
	if err != nil || saved.Name != "Updated" || saved.Host != "new.example" {
		t.Fatal(saved, err)
	}
	live, err := a.ssh.ConnectedSession(connected.Ref)
	if err != nil || live.Host != server.Host || live.Port != server.Port || live.Username != "root" {
		t.Fatal("SSH target changed after saving new settings", live, err)
	}
	if !a.ssh.Valid(connected.Ref) {
		t.Fatal("saving disconnected the live SSH connection")
	}
	session, err := a.ssh.OpenSession(connected.Ref)
	if err != nil { t.Fatal(err) }
	defer session.Close()
	result, err := session.Output("printf CONNECTED")
	if err != nil || string(result) != "CONNECTED" {
		t.Fatal("existing SSH connection cannot execute commands after save", string(result), err)
	}
	stored, err := a.store.GetSession(context.Background(), row.ID)
	if err != nil || stored.Name != "Updated" || stored.Host != "new.example" || stored.Port != 2222 || stored.Username != "deploy" {
		t.Fatal("next connection settings not persisted", stored, err)
	}
}
func TestDeleteActiveSession(t *testing.T) {
	a, _ := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	defer a.shutdown(context.Background())
	row, _ := a.SaveSession(SaveSessionRequest{Session: domain.Session{Host: "localhost", Port: 22, Username: "root"}})
	a.tabRefs["a"] = domain.ConnectionRef{TabID: "a", SessionID: row.ID}
	if e := a.DeleteSession(row.ID); e == nil {
		t.Fatal("active session deleted")
	}
}
func TestCloseDuringConnect(t *testing.T) {
	a, _ := newApp(filepath.Join(t.TempDir(), "state.db"), &vault{m: map[string]string{}}, nil)
	defer a.shutdown(context.Background())
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	go func() {
		c, e := ln.Accept()
		if e == nil {
			defer c.Close()
			time.Sleep(2 * time.Second)
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	row, _ := a.SaveSession(SaveSessionRequest{Session: domain.Session{Host: "127.0.0.1", Port: addr.Port, Username: "root"}})
	done := make(chan struct{})
	go func() { a.Connect("tab", row.ID, "x"); close(done) }()
	time.Sleep(30 * time.Millisecond)
	a.CloseTab("tab")
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("closing tab did not cancel pending handshake")
	}
	a.mu.Lock()
	_, exists := a.tabRefs["tab"]
	a.mu.Unlock()
	if exists {
		t.Fatal("closed tab resurrected")
	}
}
func TestCommittedCredentialWinsAfterCleanupFailure(t *testing.T) {
	v := &vault{m: map[string]string{}}
	a, _ := newApp(filepath.Join(t.TempDir(), "state.db"), v, nil)
	defer a.shutdown(context.Background())
	server := testssh.Start(t)
	row, e := a.SaveSession(SaveSessionRequest{Session: domain.Session{Host: server.Host, Port: server.Port, Username: "root", AuthType: "password"}, Secret: "wrong-password", SaveSecret: true})
	if e != nil {
		t.Fatal(e)
	}
	v.failDelete = true
	if _, e = a.SaveSession(SaveSessionRequest{Session: row, Secret: "test-password", SaveSecret: true}); e == nil {
		t.Fatal("cleanup failure not surfaced")
	}
	r, e := a.Connect("tab", row.ID, "")
	if e != nil || r.Challenge == nil {
		t.Fatal(r, e)
	}
	a.TrustHost(r.Challenge.ID)
	if _, e = a.Connect("tab", row.ID, ""); e != nil {
		t.Fatal("stale cached password overrode committed credential", e)
	}
}

func TestRouteEditClearsAllInMemorySessionCredentials(t *testing.T) {
 a, err := newApp(filepath.Join(t.TempDir(),"state.db"), &vault{m:map[string]string{}}, nil)
 if err != nil { t.Fatal(err) }
 defer a.shutdown(context.Background())
 session, err := a.SaveSession(SaveSessionRequest{
  Session:domain.Session{Host:"target.example",Port:22,Username:"root",AuthType:"password"},
  Secret:"first-password",SaveSecret:false,
 })
 if err != nil { t.Fatal(err) }
 if a.transient["session:"+session.ID] != "first-password" { t.Fatal("session secret not initially cached") }
 a.transient["connection:tab-one:"+session.ID] = "old-tab-one"
 a.transient["connection:tab-two:"+session.ID] = "old-tab-two"

 session.ProxyJump = "root@bastion.example"
 edited, err := a.SaveSession(SaveSessionRequest{Session:session})
 if err != nil { t.Fatal(err) }
 if edited.ProxyJump != "root@bastion.example" { t.Fatal("jump route not persisted") }
 for _, key := range []string{"session:"+session.ID,"connection:tab-one:"+session.ID,"connection:tab-two:"+session.ID} {
  if _, exists := a.transient[key]; exists { t.Fatalf("outdated credential %s retained after jump route edit",key) }
 }

 a.transient["connection:tab-three:"+session.ID] = "stale"
 edited.UseSSHConfig = true
 _, err = a.SaveSession(SaveSessionRequest{Session:edited,Secret:"new-password",SaveSecret:false})
 if err != nil { t.Fatal(err) }
 if _, exists := a.transient["connection:tab-three:"+session.ID]; exists { t.Fatal("cached tab credential survived config-mode change") }
 if a.transient["session:"+session.ID] != "new-password" { t.Fatal("newly supplied credential was not cached") }
}
