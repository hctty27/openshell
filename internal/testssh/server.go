// Package testssh provides an in-process SSH fixture for integration tests.
package testssh

import (
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"golang.org/x/crypto/ssh"
	"io"
	"net"
	"os/exec"
	"sync"
	"testing"
)

type Server struct {
	Host        string
	Port        int
	Fingerprint string
	mu          sync.Mutex
	Commands    []string
}

func Start(t testing.TB) *Server { return StartWithMode(t, "normal") }
func StartWithMode(t testing.TB, mode string) *Server {
	t.Helper()
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(key)
	cfg := &ssh.ServerConfig{PasswordCallback: func(c ssh.ConnMetadata, p []byte) (*ssh.Permissions, error) {
		if string(p) != "test-password" {
			return nil, fmt.Errorf("bad password")
		}
		return nil, nil
	}, PublicKeyCallback: func(c ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) { return nil, nil }}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().(*net.TCPAddr)
	s := &Server{Host: "127.0.0.1", Port: addr.Port, Fingerprint: ssh.FingerprintSHA256(signer.PublicKey())}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, e := ln.Accept()
			if e != nil {
				return
			}
			go func() {
				conn, chans, reqs, e := ssh.NewServerConn(c, cfg)
				if e != nil {
					c.Close()
					return
				}
				defer conn.Close()
				go ssh.DiscardRequests(reqs)
				for ch := range chans {
					if ch.ChannelType() != "session" {
						ch.Reject(ssh.UnknownChannelType, "session only")
						continue
					}
					if mode == "open" {
						continue
					}
					channel, requests, e := ch.Accept()
					if e != nil {
						continue
					}
					go func() {
						defer channel.Close()
						for r := range requests {
							switch r.Type {
							case "exec":
								if mode == "start" {
									continue
								}
								var p struct{ Command string }
								ssh.Unmarshal(r.Payload, &p)
								s.mu.Lock()
								s.Commands = append(s.Commands, p.Command)
								s.mu.Unlock()
								r.Reply(true, nil)
								cmd := exec.Command("sh", "-c", p.Command)
								cmd.Stdin = channel
								cmd.Stdout = channel
								cmd.Stderr = channel.Stderr()
								code := 0
								if e := cmd.Run(); e != nil {
									code = 1
									if ee, ok := e.(*exec.ExitError); ok {
										code = ee.ExitCode()
									}
								}
								channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{uint32(code)}))
								return
							case "pty-req", "window-change":
								r.Reply(true, nil)
							case "shell":
								r.Reply(true, nil)
								io.Copy(channel, channel)
								return
							case "signal":
								r.Reply(true, nil)
							default:
								r.Reply(false, nil)
							}
						}
					}()
				}
			}()
		}
	}()
	return s
}
func (s *Server) Count() int { s.mu.Lock(); defer s.mu.Unlock(); return len(s.Commands) }
