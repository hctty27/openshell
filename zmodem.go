package main

import (
    "os"
    "path/filepath"

    "github.com/hctty27/openshell/internal/domain"
)

type ZmodemLocalPlaces struct {
    Home string `json:"home"`
    Roots []string `json:"roots"`
}

// ZmodemLocalPlaces locates local folders without starting an SFTP session
// or opening an operating-system file dialog.
func (a *App) ZmodemLocalPlaces() (ZmodemLocalPlaces, error) {
    home, err := os.UserHomeDir()
    if err != nil {
        return ZmodemLocalPlaces{}, err
    }
    places := ZmodemLocalPlaces{Home: home}
    if os.PathSeparator == '\\' {
        for drive := 'A'; drive <= 'Z'; drive++ {
            root := string(drive) + ":\\"
            if info, err := os.Stat(root); err == nil && info.IsDir() {
                places.Roots = append(places.Roots, root)
            }
        }
    } else {
        places.Roots = []string{string(filepath.Separator)}
    }
    return places, nil
}

func (a *App) SubmitZmodemSelection(ref domain.ConnectionRef, id uint64, paths []string) error {
    return a.ssh.SubmitZmodemSelection(ref, id, paths)
}
