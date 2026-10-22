package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"strings"
	"time"

	"github.com/hctty27/openshell/internal/domain"
)

const sessionBackupFormat = "openshell-session-backup"

type sessionBackup struct {
	Format    string           `json:"format"`
	Version   int              `json:"version"`
	CreatedAt string           `json:"createdAt"`
	Groups    []domain.Group   `json:"groups"`
	Sessions  []domain.Session `json:"sessions"`
}

// ExportSessionBackup saves portable connection settings, not Windows credentials.
func (a *App) ExportSessionBackup() (string, error) {
	if a.pickBackupWrite == nil { return "", errors.New("save dialog is unavailable") }
	name, err := a.pickBackupWrite()
	if err != nil || name == "" { return "", err }
	if !strings.EqualFold(path.Ext(name), ".json") { name += ".json" }
	groups, err := a.store.ListGroups(a.ctx)
	if err != nil { return "", err }
	sessions, err := a.store.ListSessions(a.ctx)
	if err != nil { return "", err }
	for i := range sessions { sessions[i].CredentialRef = "" }
	backup := sessionBackup{Format:sessionBackupFormat, Version:1, CreatedAt:time.Now().UTC().Format(time.RFC3339), Groups:groups, Sessions:sessions}
	data, err := json.MarshalIndent(backup, "", "  ")
	if err != nil { return "", err }
	if err = os.WriteFile(name, data, 0600); err != nil { return "", err }
	return name, nil
}

func parseSessionBackup(data []byte) (XshellImportPreview, error) {
	preview := XshellImportPreview{Source:"openshell", Entries:[]XshellImportEntry{}, Skipped:[]string{}}
	if len(data) > maxXshellArchiveSize { return preview, errors.New("backup exceeds size limit") }
	var backup sessionBackup
	if err := json.Unmarshal(data, &backup); err != nil { return preview, err }
	if backup.Format != sessionBackupFormat || backup.Version != 1 { return preview, errors.New("unsupported OpenShell backup format") }
	if len(backup.Sessions) > maxXshellEntries || len(backup.Groups) > maxXshellEntries { return preview, errors.New("backup contains too many entries") }
	groups := make(map[string]domain.Group)
	for _, g := range backup.Groups {
		if g.ID == "" || g.Name == "" || strings.ContainsAny(g.Name, "/\\") { return preview, errors.New("invalid backup folder") }
		if _, exists := groups[g.ID]; exists { return preview, errors.New("duplicate folder ID") }
		groups[g.ID] = g
	}
	var folderPath func(string, map[string]bool) (string, error)
	folderPath = func(id string, seen map[string]bool) (string, error) {
		if id == "" { return "", nil }
		if seen[id] { return "", errors.New("folder cycle in backup") }
		g, ok := groups[id]
		if !ok { return "", errors.New("unknown parent folder in backup") }
		seen[id] = true
		parent, err := folderPath(g.ParentID, seen)
		delete(seen, id)
		if err != nil { return "", err }
		if parent == "" { return g.Name, nil }
		return parent+"/"+g.Name, nil
	}
	for _, s := range backup.Sessions {
		folder, err := folderPath(s.GroupID, make(map[string]bool))
		if err != nil { return preview, err }
		s.ID = ""
		s.GroupID = ""
		s.CredentialRef = ""
		s.CreatedAt, s.UpdatedAt = "", ""
		if err := domain.ValidateSession(s); err != nil {
			preview.Skipped = append(preview.Skipped, fmt.Sprintf("%s: invalid connection", s.Name))
			continue
		}
		if s.Name == "" { s.Name = s.Host }
		warning := "Saved OpenShell passwords are not restored"
		if s.AuthType == "key" { warning = "Private key path must exist on this computer" }
		preview.Entries = append(preview.Entries, XshellImportEntry{ID:domain.NewID(), Folder:folder, Session:s, Warning:warning})
	}
	// Reuse the existing transactional import flow and opaque preview token.
	preview.Token = domain.NewID()
	return preview, nil
}

func (a *App) PreviewSessionBackup() (XshellImportPreview, error) {
	empty := XshellImportPreview{Source:"openshell", Entries:[]XshellImportEntry{}, Skipped:[]string{}}
	if a.pickBackupRead == nil { return empty, errors.New("file picker is unavailable") }
	name, err := a.pickBackupRead()
	if err != nil || name == "" { return empty, err }
	info, err := os.Stat(name)
	if err != nil { return empty, err }
	if !info.Mode().IsRegular() || info.Size() > maxXshellArchiveSize { return empty, errors.New("backup file exceeds size limit") }
	data, err := os.ReadFile(name)
	if err != nil { return empty, err }
	preview, err := parseSessionBackup(data)
	if err != nil { return empty, err }
	a.mu.Lock()
	a.xshellPreview = &preview
	a.mu.Unlock()
	return preview, nil
}
