package sftp

import (
    "errors"

    "github.com/hctty27/openshell/internal/domain"
    pkg "github.com/pkg/sftp"
)

var errRemotePoolClosed = errors.New("SFTP 文件管理器已关闭")
var errRemoteConnectionChanged = errors.New("SFTP 连接已变化，请重试")

// cachedRemote keeps an interactive SFTP subsystem alive while its SSH tab exists.
// Transfers deliberately use their own subsystem so cancellation is isolated.
type cachedRemote struct {
    client *pkg.Client
    users  int
    stale  bool
}

func (m *Manager) borrowRemote(ref domain.ConnectionRef) (*pkg.Client, func(), error) {
    m.poolMu.Lock()
    epoch := m.poolEpoch[ref.TabID]
    if m.poolClosed {
        m.poolMu.Unlock()
        return nil, nil, errRemotePoolClosed
    }
    m.poolMu.Unlock()

    transport, err := m.lookup(ref)
    if err != nil {
        return nil, nil, err
    }

    m.poolMu.Lock()
    if m.poolClosed || m.poolEpoch[ref.TabID] != epoch {
        m.poolMu.Unlock()
        return nil, nil, errRemoteConnectionChanged
    }
    if entry := m.pool[ref]; entry != nil {
        entry.users++
        m.poolMu.Unlock()
        return entry.client, func() { m.releaseRemote(entry) }, nil
    }
    m.poolMu.Unlock()

    // Never hold the pool lock during the remote subsystem handshake.
    created, err := pkg.NewClient(transport)
    if err != nil {
        return nil, nil, err
    }

    m.poolMu.Lock()
    if m.poolClosed || m.poolEpoch[ref.TabID] != epoch {
        m.poolMu.Unlock()
        _ = created.Close()
        return nil, nil, errRemoteConnectionChanged
    }
    if entry := m.pool[ref]; entry != nil {
        entry.users++
        m.poolMu.Unlock()
        _ = created.Close()
        return entry.client, func() { m.releaseRemote(entry) }, nil
    }
    entry := &cachedRemote{client: created, users: 1}
    m.pool[ref] = entry
    m.poolMu.Unlock()

    // A remote subsystem can exit without the SSH connection disconnecting.
    // Evict it so the next request creates a fresh SFTP client.
    go func() {
        _ = created.Wait()
        m.expireRemote(ref, entry)
    }()
    return created, func() { m.releaseRemote(entry) }, nil
}

func (m *Manager) releaseRemote(entry *cachedRemote) {
    m.poolMu.Lock()
    entry.users--
    closeClient := entry.stale && entry.users == 0
    m.poolMu.Unlock()
    if closeClient {
        _ = entry.client.Close()
    }
}

func (m *Manager) expireRemote(ref domain.ConnectionRef, entry *cachedRemote) {
    m.poolMu.Lock()
    if m.pool[ref] == entry {
        delete(m.pool, ref)
    }
    entry.stale = true
    closeClient := entry.users == 0
    m.poolMu.Unlock()
    if closeClient {
        _ = entry.client.Close()
    }
}

func (m *Manager) invalidateRemoteClients(tabID string, onlyRef *domain.ConnectionRef) {
    m.poolMu.Lock()
    m.poolEpoch[tabID]++
    var idle []*pkg.Client
    for ref, entry := range m.pool {
        if ref.TabID != tabID || (onlyRef != nil && ref != *onlyRef) {
            continue
        }
        delete(m.pool, ref)
        entry.stale = true
        if entry.users == 0 {
            idle = append(idle, entry.client)
        }
    }
    m.poolMu.Unlock()
    for _, client := range idle {
        _ = client.Close()
    }
}

func (m *Manager) closeRemotePool() {
    m.poolMu.Lock()
    m.poolClosed = true
    var idle []*pkg.Client
    for ref, entry := range m.pool {
        delete(m.pool, ref)
        entry.stale = true
        if entry.users == 0 {
            idle = append(idle, entry.client)
        }
    }
    m.poolMu.Unlock()
    for _, client := range idle {
        _ = client.Close()
    }
}
