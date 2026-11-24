package main

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/hctty27/openshell/internal/domain"
	"github.com/hctty27/openshell/internal/testssh"
)

func TestTransientCredentialsExpireAndReplacementSurvives(t *testing.T) {
	a:= &App{}
	a.mu.Lock()
	a.cacheTransientLocked("session:one","old",10*time.Millisecond)
	a.cacheTransientLocked("session:one","new",time.Minute)
	a.cacheTransientLocked("connection:two:one","temporary",10*time.Millisecond)
	a.mu.Unlock()
	defer func(){a.mu.Lock();defer a.mu.Unlock();for k:=range a.transient{a.deleteTransientLocked(k)}}()
	deadline:=time.Now().Add(2*time.Second)
	for {
		a.mu.Lock()
		expired:=a.transient["connection:two:one"]==""
		replacement:=a.transient["session:one"]
		a.mu.Unlock()
		if replacement!="new"{t.Fatal("stale timer removed replacement credential")}
		if expired {break}
		if time.Now().After(deadline){t.Fatal("expired credential retained")}
		time.Sleep(5*time.Millisecond)
	}
}

func TestSavedSSHCredentialNeverCachedAndReconnectReadsVault(t *testing.T) {
	v:=&vault{m:map[string]string{}}
	a,err:=newApp(filepath.Join(t.TempDir(),"state.db"),v,nil)
	if err!=nil{t.Fatal(err)}
	defer a.shutdown(context.Background())
	server:=testssh.Start(t)
	row,err:=a.SaveSession(SaveSessionRequest{Session:domain.Session{Host:server.Host,Port:server.Port,Username:"root",AuthType:"password"},Secret:"test-password",SaveSecret:true})
	if err!=nil{t.Fatal(err)}
	first,err:=a.Connect("tab",row.ID,"")
	if err!=nil||first.Challenge==nil{t.Fatal(first,err)}
	if err:=a.TrustHost(first.Challenge.ID);err!=nil{t.Fatal(err)}
	live,err:=a.Connect("tab",row.ID,"")
	if err!=nil{t.Fatal(err)}
	a.mu.Lock()
	n:=len(a.transient)
	a.mu.Unlock()
	if n!=0{t.Fatal("vault credential copied to transient cache")}
	if _,err:=a.Reconnect("tab",row.ID);err!=nil{t.Fatal(err)}
	a.mu.Lock()
	n=len(a.transient)
	a.mu.Unlock()
	if n!=0{t.Fatal("reconnect cached vault credential")}
	_ = live
}

func TestCloseTabAndShutdownClearTemporaryCredentialTimers(t *testing.T) {
	a,err:=newApp(filepath.Join(t.TempDir(),"state.db"),&vault{m:map[string]string{}},nil)
	if err!=nil{t.Fatal(err)}
	a.mu.Lock()
	a.tabRefs["tab"]=domain.ConnectionRef{TabID:"tab",SessionID:"session",Generation:1}
	a.cacheTransientLocked("connection:tab:session","temporary",time.Minute)
	a.cacheTransientLocked("session:session","temporary",time.Minute)
	a.mu.Unlock()
	if err:=a.CloseTab("tab");err!=nil{t.Fatal(err)}
	a.mu.Lock()
	_,cached:=a.transient["connection:tab:session"]
	_,timer:=a.transientTimers["connection:tab:session"]
	a.mu.Unlock()
	if cached||timer{t.Fatal("closed tab retained credential or timer")}
	a.shutdown(context.Background())
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.transient)!=0||len(a.transientTimers)!=0{t.Fatal("shutdown retained credential references")}
	a.cacheTransientLocked("late","secret",time.Minute)
	if len(a.transient)!=0{t.Fatal("late callback repopulated closed credential cache")}
}
