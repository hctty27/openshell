package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	transferDefaultLocalDirKey = "transfer.defaultLocalDir"
	transferSessionLocalDirPrefix = "transfer.localDir."
)

func usableTransferDirectory(path string) (string, bool) {
	if strings.TrimSpace(path) == "" || !filepath.IsAbs(path) {
		return "", false
	}
	clean := filepath.Clean(path)
	info, err := os.Stat(clean)
	if err != nil || !info.IsDir() {
		return "", false
	}
	f, err := os.Open(clean)
	if err != nil {
		return "", false
	}
	defer f.Close()
	if _, err = f.Readdirnames(1); err != nil && !errors.Is(err, io.EOF) {
		return "", false
	}
	return clean, true
}

func (a *App) GetTransferDefaultLocalDir() (string, error) {
	preferred, err := a.store.GetPreference(a.ctx, transferDefaultLocalDirKey)
	if err != nil {
		return "", err
	}
	if directory, valid := usableTransferDirectory(preferred); valid {
		return directory, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if directory, valid := usableTransferDirectory(home); valid {
		return directory, nil
	}
	return "", fmt.Errorf("local home directory is unavailable")
}

func (a *App) SetTransferDefaultLocalDir(path string) error {
	if path == "" {
		return a.store.DeletePreference(a.ctx, transferDefaultLocalDirKey)
	}
	directory, valid := usableTransferDirectory(path)
	if !valid {
		return fmt.Errorf("local directory is invalid or inaccessible: %s", path)
	}
	return a.store.SetPreference(a.ctx, transferDefaultLocalDirKey, directory)
}

func (a *App) GetTransferLocalDir(sessionID string) (string, error) {
	if _, err := a.store.GetSession(a.ctx, sessionID); err != nil {
		return "", err
	}
	preferred, err := a.store.GetPreference(a.ctx, transferSessionLocalDirPrefix+sessionID)
	if err != nil {
		return "", err
	}
	if directory, valid := usableTransferDirectory(preferred); valid {
		return directory, nil
	}
	return a.GetTransferDefaultLocalDir()
}

func (a *App) SaveTransferLocalDir(sessionID, path string) error {
	if _, err := a.store.GetSession(a.ctx, sessionID); err != nil {
		return err
	}
	directory, valid := usableTransferDirectory(path)
	if !valid {
		return fmt.Errorf("local directory is invalid or inaccessible: %s", path)
	}
	return a.store.SetPreference(a.ctx, transferSessionLocalDirPrefix+sessionID, directory)
}
