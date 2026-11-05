package main

import (
    "context"
    "errors"
    "testing"

    "github.com/hctty27/openshell/internal/domain"
    files "github.com/hctty27/openshell/internal/sftp"
    "golang.org/x/crypto/ssh"
)

func TestRemoteTextReadCancellationArrivingBeforeStart(t *testing.T) {
    lookupCalls := 0
    a := &App{
        ctx: context.Background(),
        sftp: files.NewManager(func(domain.ConnectionRef) (*ssh.Client, error) {
            lookupCalls++
            return nil, errors.New("unexpected SSH lookup")
        }, func(string, any) {}),
    }
    defer a.sftp.Close()
    ref := domain.ConnectionRef{TabID: "tab", SessionID: "session", Generation: 1}
    a.SFTPCancelReadRemoteText("read-before-start")
    _, err := a.SFTPReadRemoteTextRequest(ref, "/tmp/config.txt", "read-before-start")
    if !errors.Is(err, context.Canceled) { t.Fatalf("expected cancellation, got %v", err) }
    if lookupCalls != 0 { t.Fatalf("network called after cancellation: %d", lookupCalls) }
}

func TestRemoteTextReadRejectsDuplicateRequestIDs(t *testing.T) {
    a := &App{}
    _, err := a.SFTPReadRemoteTextRequest(domain.ConnectionRef{}, "/", "")
    if err == nil { t.Fatal("empty read request must be rejected") }
}
