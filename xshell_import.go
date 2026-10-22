package main

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
)

const (
	maxXshellArchiveSize = 32 << 20
	maxXshellEntrySize   = 1 << 20
	maxXshellEntries     = 2000
)

type XshellImportEntry struct {
	ID      string         `json:"id"`
	Folder  string         `json:"folder"`
	Session domain.Session `json:"session"`
	Warning string         `json:"warning,omitempty"`
}
type XshellImportPreview struct {
	Source   string              `json:"source"`
	Token    string              `json:"token"`
	Entries  []XshellImportEntry `json:"entries"`
	Skipped  []string            `json:"skipped"`
}
type XshellImportResult struct {
	Imported int `json:"imported"`
	Skipped  int `json:"skipped"`
}

func parseXshellImport(filePath string) (XshellImportPreview, error) {
	result := XshellImportPreview{Source:"xshell", Entries: []XshellImportEntry{}, Skipped: []string{}}
	stat, err := os.Stat(filePath)
	if err != nil {
		return result, err
	}
	if !stat.Mode().IsRegular() || stat.Size() > maxXshellArchiveSize {
		return result, apperror.New("xshellImportXshellImportFileIsTooLargeOrNotARegularFile",nil)
	}
	ext := strings.ToLower(filepath.Ext(filePath))
	add := func(name string, data []byte) {
		if len(data) > maxXshellEntrySize {
			result.Skipped = append(result.Skipped, name+": too large")
			return
		}
		entry, err := parseXshellSession(name, data)
		if err != nil {
			result.Skipped = append(result.Skipped, name+": "+err.Error())
			return
		}
		result.Entries = append(result.Entries, entry)
	}
	switch ext {
	case ".xsh":
		data, err := os.ReadFile(filePath)
		if err != nil { return result, err }
		add(filepath.Base(filePath), data)
	case ".xts":
		reader, err := zip.OpenReader(filePath)
		if err != nil { return result, err }
		defer reader.Close()
		if len(reader.File) > maxXshellEntries {
			return result, apperror.New("xshellImportXshellArchiveContainsTooManyEntries",nil)
		}
		var total uint64
		for _, file := range reader.File {
			if !strings.EqualFold(path.Ext(file.Name), ".xsh") || file.FileInfo().IsDir() {
				continue
			}
			clean := path.Clean(strings.ReplaceAll(file.Name, "\\", "/"))
			if strings.HasPrefix(clean, "../") || clean == ".." || path.IsAbs(clean) || strings.Contains(clean, ":") {
				result.Skipped = append(result.Skipped, file.Name+": unsafe path")
				continue
			}
			if file.UncompressedSize64 > maxXshellEntrySize || total+file.UncompressedSize64 > maxXshellArchiveSize {
				result.Skipped = append(result.Skipped, clean+": size limit")
				continue
			}
			total += file.UncompressedSize64
			r, err := file.Open()
			if err != nil { return result, err }
			data, readErr := io.ReadAll(io.LimitReader(r, maxXshellEntrySize+1))
			closeErr := r.Close()
			if readErr != nil { return result, readErr }
			if closeErr != nil { return result, closeErr }
			add(clean, data)
		}
	default:
		return result, apperror.New("xshellImportSelectAnXshellXtsOrXshFile",nil)
	}
	if len(result.Entries) == 0 && len(result.Skipped) == 0 {
		return result, apperror.New("xshellImportNoXshellSSHSessionsFound",nil)
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil { return result, err }
	result.Token = hex.EncodeToString(id[:])
	return result, nil
}

func decodeXshell(data []byte) (string, error) {
	if len(data) >= 2 && ((data[0] == 0xff && data[1] == 0xfe) || (data[0] == 0xfe && data[1] == 0xff)) {
		if len(data)%2 != 0 { return "", apperror.New("xshellImportInvalidUTF16Length",nil) }
		little := data[0] == 0xff
		words := make([]uint16, 0, len(data)/2)
		for i := 2; i < len(data); i += 2 {
			if little { words = append(words, uint16(data[i])|uint16(data[i+1])<<8) } else {
				words = append(words, uint16(data[i+1])|uint16(data[i])<<8)
			}
		}
		return string(utf16.Decode(words)), nil
	}
	data = bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})
	if !utf8.Valid(data) { return "", apperror.New("xshellImportUnsupportedSessionEncoding",nil) }
	return string(data), nil
}

func parseXshellSession(filename string, data []byte) (XshellImportEntry, error) {
	entry := XshellImportEntry{}
	clean := path.Clean(strings.ReplaceAll(filename, "\\", "/"))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || path.IsAbs(clean) || strings.Contains(clean, ":") {
		return entry, apperror.New("xshellImportUnsafeSessionPath",nil)
	}
	text, err := decodeXshell(data)
	if err != nil { return entry, err }
	ini := map[string]map[string]string{}
	section := ""
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" || strings.HasPrefix(line, ";") || strings.HasPrefix(line, "#") { continue }
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.ToUpper(strings.TrimSpace(line[1:len(line)-1]))
			if ini[section] == nil { ini[section] = map[string]string{} }
			continue
		}
		if n := strings.IndexByte(line, '='); n > 0 && section != "" {
			ini[section][strings.ToUpper(strings.TrimSpace(line[:n]))] = strings.TrimSpace(line[n+1:])
		}
	}
	conn := ini["CONNECTION"]
	if conn == nil { return entry, apperror.New("xshellImportNotAnXshellConnection",nil) }
	protocol := strings.ToUpper(conn["PROTOCOL"])
	if protocol != "" && protocol != "SSH" && protocol != "SSH2" {
		return entry, apperror.New("xshellImportUnsupportedProtocol",map[string]any{"protocol":protocol})
	}
	host := strings.TrimSpace(conn["HOST"])
	if host == "" { return entry, apperror.New("xshellImportMissingHost",nil) }
	port := 22
	if conn["PORT"] != "" {
		port, err = strconv.Atoi(conn["PORT"])
		if err != nil { return entry, apperror.New("xshellImportInvalidPort",nil) }
	}
	auth := ini["CONNECTION:AUTHENTICATION"]
	username := strings.TrimSpace(auth["USERNAME"])
	if username == "" { username = strings.TrimSpace(conn["USERNAME"]) }
	if username == "" { return entry, apperror.New("xshellImportMissingUsernameConfigureItInXshellFirst",nil) }
	folder := path.Dir(clean)
	if folder == "." { folder = "" }
	parts := strings.Split(folder, "/")
	for i, part := range parts {
		if strings.EqualFold(part, "Sessions") { folder = strings.Join(parts[i+1:], "/"); break }
	}
	s := domain.Session{Name:strings.TrimSuffix(path.Base(clean), path.Ext(clean)), Host:host, Port:port, Username:username, AuthType:"password"}
	if err := domain.ValidateSession(s); err != nil { return entry, apperror.Wrap("xshellImportInvalidSshConnection",err,nil) }
	if auth["USERKEY"] != "" || auth["METHOD"] == "3" {
		entry.Warning = "Xshell public key reference is not portable; choose an OpenSSH key after import"
	} else {
		entry.Warning = "Saved Xshell passwords are not imported"
	}
	entry.ID = domain.NewID()
	entry.Folder = folder
	entry.Session = s
	return entry, nil
}

func (a *App) PreviewXshellImport() (XshellImportPreview, error) {
	empty := XshellImportPreview{Entries: []XshellImportEntry{}, Skipped: []string{}}
	if a.pickImport == nil { return empty, apperror.New("xshellImportFilePickerIsUnavailable",nil) }
	filename, err := a.pickImport()
	if err != nil || filename == "" { return empty, err }
	preview, err := parseXshellImport(filename)
	if err != nil { return empty, err }
	a.mu.Lock()
	a.xshellPreview = &preview
	a.mu.Unlock()
	return preview, nil
}

func (a *App) ImportXshell(token string, selected []string, conflict string) (XshellImportResult, error) {
	result := XshellImportResult{}
	if conflict != "skip" && conflict != "rename" { return result, apperror.New("xshellImportInvalidConflictHandling",nil) }
	a.mu.Lock()
	defer a.mu.Unlock()
	preview := a.xshellPreview
	if preview == nil || token == "" || preview.Token != token { return result, apperror.New("xshellImportImportPreviewHasExpired",nil) }
	if len(selected) == 0 { return result, apperror.New("xshellImportSelectAtLeastOneSession",nil) }
	chosen := make(map[string]bool, len(selected))
	for _, id := range selected {
		if chosen[id] { return result, apperror.New("xshellImportDuplicateSelection",nil) }
		chosen[id] = true
	}
	if len(chosen) > len(preview.Entries) { return result, apperror.New("xshellImportInvalidSelection",nil) }
	existingGroups, err := a.store.ListGroups(a.ctx)
	if err != nil { return result, err }
	existingSessions, err := a.store.ListSessions(a.ctx)
	if err != nil { return result, err }
	groupMap := make(map[string]string)
	for _, g := range existingGroups { groupMap[g.ParentID+"\x00"+g.Name] = g.ID }
	newGroups := []domain.Group{}
	newSessions := []domain.Session{}
	names := map[string]bool{}
	for _, s := range existingSessions { names[s.GroupID+"\x00"+s.Name] = true }
	for _, entry := range preview.Entries {
		if !chosen[entry.ID] { continue }
		groupID := ""
		for _, folder := range strings.Split(entry.Folder, "/") {
			if folder == "" { continue }
			key := groupID+"\x00"+folder
			id := groupMap[key]
			if id == "" {
				id = domain.NewID()
				groupMap[key] = id
				newGroups = append(newGroups, domain.Group{ID:id, Name:folder, ParentID:groupID})
			}
			groupID = id
		}
		row := entry.Session
		row.ID = domain.NewID()
		row.GroupID = groupID
		name := row.Name
		key := groupID+"\x00"+name
		if names[key] && conflict == "skip" { result.Skipped++; continue }
		if names[key] {
			for suffix := 2; ; suffix++ {
				candidate := fmt.Sprintf("%s (%d)", name, suffix)
				if !names[groupID+"\x00"+candidate] { row.Name=candidate; break }
			}
		}
		names[groupID+"\x00"+row.Name] = true
		newSessions = append(newSessions, row)
	}
	for id := range chosen {
		found := false
		for _, entry := range preview.Entries { if entry.ID == id { found=true; break } }
		if !found { return XshellImportResult{}, apperror.New("xshellImportInvalidSelection",nil) }
	}
	if err := a.store.ImportSessions(a.ctx, newGroups, newSessions); err != nil { return XshellImportResult{}, err }
	result.Imported = len(newSessions)
	a.xshellPreview = nil
	return result, nil
}
