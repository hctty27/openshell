package sshclient

import (
 "fmt"
 "io"
 "net"
 "sync"

 "github.com/hctty27/openshell/internal/domain"
 "golang.org/x/crypto/ssh"
)

// localForward owns the listener and active TCP connections. Closing the SSH
// tab closes both its listeners and any outstanding forwarded connections.
type localForward struct {
 listener net.Listener
 mu sync.Mutex
 active map[net.Conn]struct{}
 closed bool
}

func (f *localForward) add(conn net.Conn) bool {
 f.mu.Lock()
 defer f.mu.Unlock()
 if f.closed { return false }
 f.active[conn] = struct{}{}
 return true
}
func (f *localForward) remove(conn net.Conn) {
 f.mu.Lock()
 delete(f.active,conn)
 f.mu.Unlock()
}
func (f *localForward) close() {
 f.mu.Lock()
 if f.closed { f.mu.Unlock(); return }
 f.closed = true
 connections := make([]net.Conn,0,len(f.active))
 for c := range f.active { connections = append(connections,c) }
 f.mu.Unlock()
 _ = f.listener.Close()
 for _, c := range connections { _ = c.Close() }
}
func closeForwardListeners(c *connection) {
 for _, forward := range c.forwards { forward.close() }
}

func (m *Manager) prepareLocalForwards(c *connection, rules []domain.LocalForward) error {
 for _, rule := range rules {
  host := rule.BindHost
  if host == "" { host = "127.0.0.1" }
  address := net.JoinHostPort(host, fmt.Sprint(rule.BindPort))
  ln, err := net.Listen("tcp", address)
  if err != nil {
   closeForwardListeners(c)
   return fmt.Errorf("local port forward %s: %w", address, err)
  }
  forward := &localForward{listener:ln,active:map[net.Conn]struct{}{}}
  c.forwards = append(c.forwards,forward)
  target := Address(rule.TargetHost,rule.TargetPort)
  go m.serveLocalForward(c.client,forward,target)
 }
 return nil
}

func (m *Manager) serveLocalForward(client *ssh.Client, forward *localForward, target string) {
 for {
  local,err := forward.listener.Accept()
  if err != nil { return }
  if !forward.add(local) { _ = local.Close(); return }
  go func(){
   defer forward.remove(local)
   defer local.Close()
   remote,err := client.Dial("tcp",target)
   if err != nil { return }
   defer remote.Close()
   done:=make(chan struct{})
   go func(){
    _,_ = io.Copy(remote,local)
    if half, ok := remote.(interface{ CloseWrite() error });ok { _=half.CloseWrite() } else { _=remote.Close() }
    close(done)
   }()
   _,_ = io.Copy(local,remote)
   _=local.Close()
   _=remote.Close()
   <-done
  }()
 }
}
