package sshclient

import (
 "context"
 "errors"
 "fmt"
 "io"
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

func TestProxyJumpRequiresTrustAtEveryHop(t *testing.T) {
 bastion:=testssh.Start(t)
 target:=testssh.Start(t)
 m:=NewManager(keys{},nil)
 defer m.Close()
 session:=domain.Session{ID:"proxy",Host:target.Host,Port:target.Port,Username:"root",AuthType:"password",ProxyJump:fmt.Sprintf("root@%s:%d",bastion.Host,bastion.Port)}
 for _, expected := range []string{Address(bastion.Host,bastion.Port),Address(target.Host,target.Port)} {
  _,err:=m.Connect(context.Background(),"jump-tab",session,AuthInput{Password:"test-password"})
  var challenge *HostKeyError
  if !errors.As(err,&challenge) { t.Fatalf("expected host-key challenge for %s, got %v",expected,err) }
  if challenge.Address!=expected { t.Fatalf("challenge address %s, expected %s",challenge.Address,expected) }
  if err:=m.keys.Trust(challenge.Address,challenge.Key);err!=nil { t.Fatal(err) }
 }
 ref,err:=m.Connect(context.Background(),"jump-tab",session,AuthInput{Password:"test-password"})
 if err!=nil { t.Fatal(err) }
 if !m.Valid(ref) { t.Fatal("jump connection was not registered") }
 if err:=m.Disconnect(ref);err!=nil { t.Fatal(err) }
}

func TestLocalForwardDeliversBytes(t *testing.T) {
 target,err:=net.Listen("tcp","127.0.0.1:0")
 if err!=nil { t.Fatal(err) }
 defer target.Close()
 go func(){
  for {
   conn,err:=target.Accept()
   if err!=nil{return}
   go func(){defer conn.Close();_,_=io.Copy(conn,conn)}()
  }
 }()
 m,s:=trustedTestManager(t)
 port:=freePort(t)
 s.LocalForwards=[]domain.LocalForward{{BindHost:"127.0.0.1",BindPort:port,TargetHost:"127.0.0.1",TargetPort:target.Addr().(*net.TCPAddr).Port}}
 ref,err:=m.Connect(context.Background(),"data-forward",s,AuthInput{Password:"test-password"})
 if err!=nil { t.Fatal(err) }
 defer m.Disconnect(ref)
 local,err:=net.DialTimeout("tcp",Address("127.0.0.1",port),time.Second)
 if err!=nil { t.Fatal(err) }
 defer local.Close()
 _=local.SetDeadline(time.Now().Add(4*time.Second))
 _,err=local.Write([]byte("hello"))
 if err!=nil { t.Fatal(err) }
 buf:=make([]byte,5)
 if _,err:=io.ReadFull(local,buf);err!=nil { t.Fatal(err) }
 if string(buf)!="hello" { t.Fatalf("forward changed bytes: %q",buf) }
}

func TestTwoHopProxyJumpAuthenticatesEachTransport(t *testing.T) {
 first := testssh.Start(t)
 second := testssh.Start(t)
 target := testssh.Start(t)
 m := NewManager(keys{}, nil)
 defer m.Close()
 session := domain.Session{
  ID: "two-hop", Host: target.Host, Port: target.Port,
  Username: "root", AuthType: "password",
  ProxyJump: fmt.Sprintf("root@%s:%d,root@%s:%d",first.Host,first.Port,second.Host,second.Port),
 }
 addresses := []string{
  Address(first.Host, first.Port),
  Address(second.Host, second.Port),
  Address(target.Host, target.Port),
 }
 for _, expected := range addresses {
  _, err := m.Connect(context.Background(), "two-hop-tab", session, AuthInput{Password:"test-password"})
  var challenge *HostKeyError
  if !errors.As(err,&challenge) { t.Fatalf("%s: expected trust challenge, got %v",expected,err) }
  if challenge.Address != expected { t.Fatalf("trusted wrong jump: got %q want %q",challenge.Address,expected) }
  if err := m.keys.Trust(challenge.Address,challenge.Key);err!=nil { t.Fatal(err) }
 }
 ref, err := m.Connect(context.Background(), "two-hop-tab",session,AuthInput{Password:"test-password"})
 if err != nil { t.Fatal(err) }
 if !m.Valid(ref) { t.Fatal("two-hop SSH reference not valid") }
 if err := m.Disconnect(ref);err!=nil { t.Fatal(err) }
}

func TestLocalForwardReconnectRebindsSamePort(t *testing.T) {
 m, session := trustedTestManager(t)
 port := freePort(t)
 session.LocalForwards = []domain.LocalForward{{
  BindHost: "127.0.0.1", BindPort: port,
  TargetHost: "127.0.0.1", TargetPort: 80,
 }}
 a, err := m.Connect(context.Background(),"reconnect-tab",session,AuthInput{Password:"test-password"})
 if err != nil { t.Fatal(err) }
 b, err := m.Connect(context.Background(),"reconnect-tab",session,AuthInput{Password:"test-password"})
 if err != nil { t.Fatalf("reconnect could not rebind released local port: %v",err) }
 if b.Generation <= a.Generation || m.Valid(a) || !m.Valid(b) {
  t.Fatalf("reconnect generation mismatch: before %+v after %+v", a,b)
 }
 if err := m.Disconnect(a);err!=nil { t.Fatal(err) }
 conn, err := net.DialTimeout("tcp", Address("127.0.0.1",port),time.Second)
 if err != nil { t.Fatalf("stale disconnect removed new forward: %v",err) }
 _ = conn.Close()
 if err := m.Disconnect(b);err!=nil { t.Fatal(err) }
}
