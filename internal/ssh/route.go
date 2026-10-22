package sshclient

import (
 "context"
 "errors"
 "fmt"
 "net"
 "os"
 "runtime"
 "strconv"
 "strings"
 "sync"
 "time"

 "golang.org/x/crypto/ssh"
 "golang.org/x/crypto/ssh/agent"
)

// authenticationMethods may keep an SSH agent socket open until all hop
// handshakes complete. No agent private key material is copied into OpenShell.
func authenticationMethods(ctx context.Context, authType, keyPath string, auth AuthInput) ([]ssh.AuthMethod, func(), error) {
 switch authType {
 case "agent":
  conn, err := openAgent()
  if err != nil { return nil, nil, fmt.Errorf("SSH agent unavailable: %w", err) }
  signers, err := loadAgentSigners(ctx, conn)
  if err != nil { conn.Close(); return nil, nil, fmt.Errorf("SSH agent keys: %w", err) }
  if len(signers) == 0 { conn.Close(); return nil, nil, errors.New("SSH agent has no loaded keys") }
  return []ssh.AuthMethod{ssh.PublicKeys(signers...)}, func(){ _ = conn.Close() }, nil
 case "key":
  data, err := os.ReadFile(expandUserPath(keyPath))
  if err != nil { return nil, nil, fmt.Errorf("SSH private key read: %w", err) }
  var signer ssh.Signer
  if auth.Passphrase != "" { signer, err = ssh.ParsePrivateKeyWithPassphrase(data, []byte(auth.Passphrase)) } else { signer, err = ssh.ParsePrivateKey(data) }
  if err != nil { return nil, nil, fmt.Errorf("SSH private key invalid: %w", err) }
  return []ssh.AuthMethod{ssh.PublicKeys(signer)}, func(){}, nil
 default:
  return []ssh.AuthMethod{ssh.Password(auth.Password)}, func(){}, nil
 }
}


type agentSignerResult struct {
 signers []ssh.Signer
 err error
}

// loadAgentSigners bounds a potentially stuck agent request by the same
// deadline as the SSH connection. Closing conn unblocks a stuck Read/Write.
func loadAgentSigners(ctx context.Context, conn net.Conn) ([]ssh.Signer, error) {
 result := make(chan agentSignerResult, 1)
 go func() {
  signers, err := agent.NewClient(conn).Signers()
  result <- agentSignerResult{signers: signers, err: err}
 }()
 select {
 case <-ctx.Done():
  _ = conn.Close()
  return nil, ctx.Err()
 case value := <-result:
  if err := ctx.Err(); err != nil {
   _ = conn.Close()
   return nil, err
  }
  return value.signers, value.err
 }
}

func openAgent() (net.Conn, error) {
 address := os.Getenv("SSH_AUTH_SOCK")
 if runtime.GOOS == "windows" {
  if address == "" { address = `\\.\pipe\openssh-ssh-agent` }
  // Windows OpenSSH's agent service exposes a named pipe, not a Unix socket.
  f, err := os.OpenFile(address, os.O_RDWR, 0)
  if err != nil { return nil, err }
  return &agentPipe{File: f}, nil
 }
 if address == "" { return nil, errors.New("SSH_AUTH_SOCK is not set") }
 return net.DialTimeout("unix", address, 3*time.Second)
}

type agentPipe struct{ *os.File }
func (p *agentPipe) LocalAddr() net.Addr { return pipeAddr("local-agent") }
func (p *agentPipe) RemoteAddr() net.Addr { return pipeAddr("ssh-agent") }
func (p *agentPipe) SetDeadline(t time.Time) error { return p.File.SetDeadline(t) }
func (p *agentPipe) SetReadDeadline(t time.Time) error { return p.File.SetReadDeadline(t) }
func (p *agentPipe) SetWriteDeadline(t time.Time) error { return p.File.SetWriteDeadline(t) }
type pipeAddr string
func (p pipeAddr) Network() string { return "pipe" }
func (p pipeAddr) String() string { return string(p) }

type jumpHost struct {
 address string
 user string
 alias string
 port int
 explicitUser bool
 explicitPort bool
}

// parseProxyJump deliberately supports SSH jump endpoints only, never arbitrary
// ProxyCommand shell fragments. At most three hops are allowed.
func parseProxyJump(spec, defaultUser string) ([]jumpHost, error) {
 if spec == "" || spec == "none" { return nil, nil }
 parts := strings.Split(spec, ",")
 if len(parts) > 3 { return nil, errors.New("a maximum of three ProxyJump hops is supported") }
 hops := make([]jumpHost, 0, len(parts))
 for _, item := range parts {
  if strings.ContainsAny(item, " \t\r\n;|&$\"'\\") { return nil, fmt.Errorf("invalid ProxyJump host %q", item) }
  user := defaultUser
  userExplicit := false
  portExplicit := false
  if pos := strings.LastIndex(item, "@"); pos >= 0 {
   user, item = item[:pos], item[pos+1:]
   userExplicit = true
  }
  host := item
  port := 22
  if strings.HasPrefix(item, "[") {
   end := strings.Index(item, "]")
   if end < 0 { return nil, fmt.Errorf("invalid IPv6 ProxyJump host %q", item) }
   host = item[1:end]
   if len(item) > end+1 {
    if item[end+1] != ':' { return nil, fmt.Errorf("invalid ProxyJump port %q", item) }
    n, err := strconv.Atoi(item[end+2:])
    if err != nil || n < 1 || n > 65535 { return nil, fmt.Errorf("invalid ProxyJump port %q", item) }
    port = n
    portExplicit = true
   }
  } else if strings.Count(item, ":") == 1 {
   var p string
   host, p, _ = strings.Cut(item, ":")
   n, err := strconv.Atoi(p)
   if err != nil || n < 1 || n > 65535 { return nil, fmt.Errorf("invalid ProxyJump port %q", item) }
   port = n
   portExplicit = true
  } else if strings.Contains(item, ":") {
   return nil, fmt.Errorf("bracket IPv6 ProxyJump hosts: %q", item)
  }
  if host == "" || user == "" || strings.ContainsAny(host, "/@") { return nil, fmt.Errorf("invalid ProxyJump host %q", item) }
  hops = append(hops, jumpHost{address: Address(host, port), user: user, alias: host, port: port, explicitUser: userExplicit, explicitPort: portExplicit})
 }
 return hops, nil
}

func (m *Manager) handshake(ctx context.Context, raw net.Conn, addr, user string, authMethods []ssh.AuthMethod) (*ssh.Client, error) {
 var hostErr *HostKeyError
 cfg := &ssh.ClientConfig{User: user, Auth: authMethods, HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
  trusted, err := m.keys.Lookup(addr)
  if err != nil { return err }
  if len(trusted) == 0 || string(trusted) != string(key.Marshal()) {
   hostErr = &HostKeyError{Address: addr, Fingerprint: ssh.FingerprintSHA256(key), Key: key.Marshal(), Changed: len(trusted) != 0}
   return hostErr
  }
  return nil
 }}
 _ = raw.SetDeadline(time.Now().Add(15*time.Second))
 done := make(chan struct{})
 go func() { select { case <-ctx.Done(): _ = raw.Close(); case <-done: } }()
 cc, chans, reqs, err := ssh.NewClientConn(raw, addr, cfg)
 close(done)
 if err != nil {
  _ = raw.Close()
  if hostErr != nil { return nil, hostErr }
  return nil, err
 }
 _ = raw.SetDeadline(time.Time{})
 return ssh.NewClient(cc, chans, reqs), nil
}

// dialRoute authenticates each SSH hop and validates each hop's public host key.
// Intermediary clients stay owned by the final connection until it disconnects.
func closeHopClients(hops []*ssh.Client) {
 for i := len(hops)-1; i >= 0; i-- { _ = hops[i].Close() }
}

func closeSSHConnection(c *connection) {
 if c == nil { return }
 closeForwardListeners(c)
 if c.client != nil { _ = c.client.Close() }
 closeHopClients(c.hops)
}

func (m *Manager) dialRoute(ctx context.Context, address, user string, methods []ssh.AuthMethod, hops []jumpHost) (*ssh.Client, []*ssh.Client, error) {
 clients := make([]*ssh.Client, 0, len(hops))
 var mu sync.Mutex
 release := func() {
  mu.Lock()
  snapshot := append([]*ssh.Client(nil), clients...)
  mu.Unlock()
  closeHopClients(snapshot)
 }
 stop := make(chan struct{})
 watcherDone := make(chan struct{})
 go func() {
  defer close(watcherDone)
  select {
  case <-ctx.Done():
   select { case <-stop: return; default: release() }
  case <-stop:
  }
 }()
 defer func(){ close(stop); <-watcherDone }()
 for i := 0; i <= len(hops); i++ {
  target, login := address, user
  if i < len(hops) { target, login = hops[i].address, hops[i].user }
  var raw net.Conn
  var err error
  if i == 0 {
   raw, err = (&net.Dialer{}).DialContext(ctx, "tcp", target)
  } else {
   raw, err = clients[i-1].Dial("tcp", target)
  }
  if err != nil { release(); return nil, nil, fmt.Errorf("SSH connection to %s: %w", target, err) }
  client, err := m.handshake(ctx, raw, target, login, methods)
  if err != nil { release(); return nil, nil, err }
  if ctx.Err() != nil {
   _ = client.Close()
   release()
   return nil, nil, ctx.Err()
  }
  if i == len(hops) { return client, clients, nil }
  mu.Lock()
  clients = append(clients, client)
  mu.Unlock()
 }
 return nil, nil, errors.New("unreachable SSH route")
}
