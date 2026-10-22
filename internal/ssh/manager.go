package sshclient

import (
	"context"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
	"golang.org/x/crypto/ssh"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type HostKeyStore interface {
	Lookup(string) ([]byte, error)
	Trust(string, []byte) error
}
type HostKeyError struct {
	Address     string `json:"address"`
	Fingerprint string `json:"fingerprint"`
	Key         []byte `json:"key"`
	Changed     bool   `json:"changed"`
}

func (e *HostKeyError) Error() string {
	if e.Changed {
		return apperror.New("fingerprintChanged", nil).Error()
	}
	return apperror.New("fingerprintFirst", nil).Error()
}

type AuthInput struct {
	Password   string
	Passphrase string
}
type EmitFunc func(string, any)
type connection struct {
	ref      domain.ConnectionRef
	session  domain.Session
	client   *ssh.Client
	terminal *ssh.Session
	stdin    interface{ Write([]byte) (int, error) }
	filter   interface { Close(); SetTerminalColumns(int32); IsTransferringFiles() bool; StopTransferringFiles(bool) }
	transferring bool
	history  *History
	sequence uint64
	keepaliveCancel context.CancelFunc
	disconnectReason string
}
type Manager struct {
	mu          sync.Mutex
	keys        HostKeyStore
	emit        EmitFunc
	connections map[string]*connection
	generations map[string]uint64
	connecting  map[string]context.CancelFunc
	keepaliveInterval time.Duration
	closed      bool
}

func NewManager(keys HostKeyStore, emit EmitFunc) *Manager {
	if emit == nil {
		emit = func(string, any) {}
	}
	return &Manager{keys: keys, emit: emit, connections: map[string]*connection{}, generations: map[string]uint64{}, connecting: map[string]context.CancelFunc{}, keepaliveInterval: 30 * time.Second}
}
func Address(host string, port int) string {
	return net.JoinHostPort(strings.Trim(host, "[]"), strconv.Itoa(port))
}
func (m *Manager) Connect(ctx context.Context, tab string, s domain.Session, auth AuthInput) (domain.ConnectionRef, error) {
	if e := domain.ValidateSession(s); e != nil {
		return domain.ConnectionRef{}, e
	}
	if tab == "" {
		return domain.ConnectionRef{}, apperror.New("invalidTerminal", nil)
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return domain.ConnectionRef{}, apperror.New("applicationIsClosed", nil)
	}
	if cancel := m.connecting[tab]; cancel != nil {
		cancel()
	}
	if old := m.connections[tab]; old != nil {
		if old.keepaliveCancel != nil { old.keepaliveCancel() }
		old.client.Close()
		delete(m.connections, tab)
	}
	m.generations[tab]++
	ref := domain.ConnectionRef{TabID: tab, SessionID: s.ID, Generation: m.generations[tab]}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	m.connecting[tab] = cancel
	m.mu.Unlock()
	defer cancel()
	address := Address(s.Host, s.Port)
	var method ssh.AuthMethod
	if s.AuthType == "key" {
		key, e := os.ReadFile(s.PrivateKeyPath)
		if e != nil {
			return ref, domain.Error("private_key", apperror.New("privateKeyRead", nil).Error())
		}
		var signer ssh.Signer
		if auth.Passphrase != "" {
			signer, e = ssh.ParsePrivateKeyWithPassphrase(key, []byte(auth.Passphrase))
		} else {
			signer, e = ssh.ParsePrivateKey(key)
		}
		if e != nil {
			return ref, domain.Error("private_key", apperror.New("privateKeyInvalid", nil).Error())
		}
		method = ssh.PublicKeys(signer)
	} else {
		method = ssh.Password(auth.Password)
	}
	var hostErr *HostKeyError
	cfg := &ssh.ClientConfig{User: s.Username, Auth: []ssh.AuthMethod{method}, HostKeyCallback: func(host string, remote net.Addr, key ssh.PublicKey) error {
		trusted, e := m.keys.Lookup(address)
		if e != nil {
			return e
		}
		if len(trusted) == 0 || string(trusted) != string(key.Marshal()) {
			hostErr = &HostKeyError{address, ssh.FingerprintSHA256(key), key.Marshal(), len(trusted) > 0}
			return hostErr
		}
		return nil
	}}
	raw, e := (&net.Dialer{}).DialContext(ctx, "tcp", address)
	if e != nil {
		return ref, domain.Error("connect", apperror.Wrap("sshConnect", e, nil).Error())
	}
	raw.SetDeadline(time.Now().Add(15 * time.Second))
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			raw.Close()
		case <-done:
		}
	}()
	cc, chans, reqs, e := ssh.NewClientConn(raw, address, cfg)
	close(done)
	if e != nil {
		raw.Close()
		if hostErr != nil {
			return ref, hostErr
		}
		return ref, domain.Error("authentication", apperror.New("sshAuthentication", nil).Error())
	}
	raw.SetDeadline(time.Time{})
	client := ssh.NewClient(cc, chans, reqs)
	m.mu.Lock()
	if m.generations[tab] != ref.Generation || m.closed {
		m.mu.Unlock()
		client.Close()
		return ref, apperror.New("connectionCancelled", nil)
	}
	delete(m.connecting, tab)
	c := &connection{ref: ref, session: s, client: client, history: NewHistory(1024 * 1024)}
	m.connections[tab] = c
	m.startKeepaliveLocked(c)
	m.mu.Unlock()
	go func() {
		err := client.Wait()
		m.mu.Lock()
		if m.connections[tab] == c {
			delete(m.connections, tab)
			if c.keepaliveCancel != nil { c.keepaliveCancel() }
			reason := c.disconnectReason
			if reason == "" { reason = classifyDisconnect(err) }
			m.mu.Unlock()
			m.emit("ssh:connection-lost", map[string]any{"ref": ref, "reason": reason})
			m.emit("ssh:disconnected", ref)
		} else {
			m.mu.Unlock()
		}
	}()
	return ref, nil
}
func (m *Manager) OpenSession(ref domain.ConnectionRef) (*ssh.Session, error) {
	m.mu.Lock()
	c := m.connections[ref.TabID]
	if c == nil || c.ref != ref {
		m.mu.Unlock()
		return nil, domain.Error("stale", apperror.New("staleConnection", nil).Error())
	}
	client := c.client
	m.mu.Unlock()
	return client.NewSession()
}
func (m *Manager) ConnectedSession(ref domain.ConnectionRef) (domain.Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.connections[ref.TabID]
	if c == nil || c.ref != ref {
		return domain.Session{}, domain.Error("stale", apperror.New("staleConnection", nil).Error())
	}
	return c.session, nil
}
func (m *Manager) Valid(ref domain.ConnectionRef) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.connections[ref.TabID]
	return c != nil && c.ref == ref
}
func (m *Manager) Active(sessionID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range m.connections {
		if c.ref.SessionID == sessionID {
			return true
		}
	}
	return false
}
func (m *Manager) Disconnect(ref domain.ConnectionRef) error {
	m.mu.Lock()
	if m.generations[ref.TabID] == ref.Generation {
		m.generations[ref.TabID]++
		if cancel := m.connecting[ref.TabID]; cancel != nil {
			cancel()
			delete(m.connecting, ref.TabID)
		}
	}
	c := m.connections[ref.TabID]
	if c == nil || c.ref != ref {
		m.mu.Unlock()
		return nil
	}
	delete(m.connections, ref.TabID)
	if c.keepaliveCancel != nil { c.keepaliveCancel() }
	m.mu.Unlock()
	e := c.client.Close()
	m.emit("ssh:disconnected", ref)
	return e
}
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	for _, cancel := range m.connecting {
		cancel()
	}
	for _, c := range m.connections {
		if c.keepaliveCancel != nil { c.keepaliveCancel() }
		c.client.Close()
	}
	m.connections = map[string]*connection{}
}
func (m *Manager) Home(ref domain.ConnectionRef) (string, error) {
	s, e := m.OpenSession(ref)
	if e != nil {
		return "", e
	}
	defer s.Close()
	s.Stdin = strings.NewReader("")
	done := make(chan struct{})
	timer := time.AfterFunc(5*time.Second, func() { s.Close() })
	defer timer.Stop()
	out, e := s.Output("printf '%s' \"$HOME\"")
	close(done)
	home := strings.TrimSpace(string(out))
	if e != nil || !strings.HasPrefix(home, "/") {
		return "", apperror.New("couldNotGetHomeDirectoryEnterAnAbsolute", nil)
	}
	return home, nil
}

func (m *Manager) CancelTab(tab string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.generations[tab]++
	if cancel := m.connecting[tab]; cancel != nil {
		cancel()
		delete(m.connecting, tab)
	}
	if c := m.connections[tab]; c != nil {
		delete(m.connections, tab)
		if c.keepaliveCancel != nil { c.keepaliveCancel() }
		c.client.Close()
	}
}

// Client returns the authenticated SSH transport for a live tab reference.
func (m *Manager) Client(ref domain.ConnectionRef) (*ssh.Client, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.connections[ref.TabID]
	if c == nil || c.ref != ref {
		return nil, domain.Error("stale", apperror.New("staleConnection", nil).Error())
	}
	return c.client, nil
}

func classifyDisconnect(err error) string {
	if err == nil { return "remote_closed" }
	if netErr, ok := err.(net.Error); ok && netErr.Timeout() { return "network_timeout" }
	return "connection_lost"
}

// SetKeepAliveInterval reconfigures active sessions without closing the transport.
// A zero interval disables protocol-level keepalive.
func (m *Manager) SetKeepAliveInterval(interval time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.keepaliveInterval = interval
	for _, c := range m.connections {
		if c.keepaliveCancel != nil { c.keepaliveCancel() }
		m.startKeepaliveLocked(c)
	}
}

// Caller holds m.mu.
func (m *Manager) startKeepaliveLocked(c *connection) {
	c.keepaliveCancel = nil
	if m.keepaliveInterval <= 0 { return }
	ctx, cancel := context.WithCancel(context.Background())
	c.keepaliveCancel = cancel
	interval := m.keepaliveInterval
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				done := make(chan error, 1)
				go func() {
					// A negative reply still proves the SSH peer is reachable.
					_, _, err := c.client.SendRequest("keepalive@openssh.com", true, nil)
					done <- err
				}()
				select {
				case <-ctx.Done():
					return
				case err := <-done:
					if err == nil { continue }
					m.mu.Lock()
					if m.connections[c.ref.TabID] == c { c.disconnectReason = "keepalive_failed" }
					m.mu.Unlock()
					_ = c.client.Close()
					return
				case <-time.After(10 * time.Second):
					m.mu.Lock()
					if m.connections[c.ref.TabID] == c { c.disconnectReason = "keepalive_timeout" }
					m.mu.Unlock()
					_ = c.client.Close()
					return
				}
			}
		}
	}()
}
