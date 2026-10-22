package sshclient

import (
 "context"
 "errors"
 "net"
 "strconv"
 "testing"
 "time"

 "github.com/hctty27/openshell/internal/domain"
 "github.com/hctty27/openshell/internal/testssh"
)

func freePort(t *testing.T) int {
 t.Helper()
 l,err:=net.Listen("tcp","127.0.0.1:0")
 if err != nil { t.Fatal(err) }
 port:=l.Addr().(*net.TCPAddr).Port
 _=l.Close()
 return port
}

func trustedTestManager(t *testing.T) (*Manager,domain.Session) {
 t.Helper()
 srv:=testssh.Start(t)
 m:=NewManager(keys{},nil)
 t.Cleanup(m.Close)
 s:=domain.Session{ID:"test",Host:srv.Host,Port:srv.Port,Username:"root",AuthType:"password"}
 _,err:=m.Connect(context.Background(),"initial",s,AuthInput{Password:"test-password"})
 var challenge *HostKeyError
 if !errors.As(err,&challenge) { t.Fatalf("expected host-key challenge, got %v",err) }
 if err:=m.keys.Trust(challenge.Address,challenge.Key);err!=nil { t.Fatal(err) }
 return m,s
}

func TestLocalForwardLifecycle(t *testing.T) {
 m,s:=trustedTestManager(t)
 port:=freePort(t)
 s.LocalForwards=[]domain.LocalForward{{BindHost:"127.0.0.1",BindPort:port,TargetHost:"127.0.0.1",TargetPort:8080}}
 ref,err:=m.Connect(context.Background(),"forward",s,AuthInput{Password:"test-password"})
 if err!=nil { t.Fatal(err) }
 address:=net.JoinHostPort("127.0.0.1",strconv.Itoa(port))
 conn,err:=net.DialTimeout("tcp",address,time.Second)
 if err!=nil { t.Fatalf("local listener not active: %v",err) }
 _=conn.Close()
 if err:=m.Disconnect(ref);err!=nil { t.Fatal(err) }
 conn,err=net.DialTimeout("tcp",address,100*time.Millisecond)
 if err==nil { conn.Close(); t.Fatal("forward listener survived SSH disconnect") }
}

func TestLocalForwardBindFailure(t *testing.T) {
 m,s:=trustedTestManager(t)
 occupied,err:=net.Listen("tcp","127.0.0.1:0")
 if err!=nil { t.Fatal(err) }
 defer occupied.Close()
 port:=occupied.Addr().(*net.TCPAddr).Port
 s.LocalForwards=[]domain.LocalForward{{BindHost:"127.0.0.1",BindPort:port,TargetHost:"127.0.0.1",TargetPort:80}}
 ref,err:=m.Connect(context.Background(),"failed-forward",s,AuthInput{Password:"test-password"})
 if err==nil { t.Fatal("accepted occupied local port") }
 if m.Valid(ref) { t.Fatal("connection leaked after bind failure") }
}

func TestLocalForwardValidationRejectsPublicBind(t *testing.T) {
 s:=domain.Session{Host:"example.com",Port:22,Username:"root",AuthType:"password",LocalForwards:[]domain.LocalForward{{BindHost:"0.0.0.0",BindPort:8080,TargetHost:"127.0.0.1",TargetPort:80}}}
 if err:=domain.ValidateSession(s);err==nil { t.Fatal("accepted public local forward bind") }
 s.LocalForwards[0].BindHost="127.0.0.1"
 if err:=domain.ValidateSession(s);err!=nil { t.Fatal(err) }
}
