package sshclient

import (
 "context"
 "crypto/ed25519"
 "crypto/rand"
 "errors"
 "net"
 "testing"
 "time"

 "golang.org/x/crypto/ssh/agent"
)

func TestAgentSignerLookupCanBeCancelled(t *testing.T) {
 client, server := net.Pipe()
 defer server.Close()
 ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
 defer cancel()

 began := time.Now()
 _, err := loadAgentSigners(ctx, client)
 if !errors.Is(err, context.DeadlineExceeded) { t.Fatalf("expected deadline error, got %v", err) }
 if time.Since(began) > time.Second { t.Fatal("agent key lookup ignored cancellation") }
}

func TestAgentSignerRequestRoundTrip(t *testing.T) {
 client, server := net.Pipe()
 defer client.Close()
 defer server.Close()
 keyring := agent.NewKeyring()
 _, privateKey, err := ed25519.GenerateKey(rand.Reader)
 if err != nil { t.Fatal(err) }
 if err := keyring.Add(agent.AddedKey{PrivateKey: privateKey, Comment: "test"}); err != nil { t.Fatal(err) }
 agentDone := make(chan error, 1)
 go func() { agentDone <- agent.ServeAgent(keyring, server) }()

 ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
 defer cancel()
 signers, err := loadAgentSigners(ctx, client)
 if err != nil { t.Fatal(err) }
 if len(signers) != 1 { t.Fatalf("expected one agent key; got %d", len(signers)) }
 sig, err := signers[0].Sign(rand.Reader, []byte("signed by test agent"))
 if err != nil || sig == nil { t.Fatalf("agent signature failed: %v", err) }
 _ = client.Close()
 select {
 case <-agentDone:
 case <-time.After(time.Second): t.Fatal("agent protocol handler did not exit after close")
 }
}
