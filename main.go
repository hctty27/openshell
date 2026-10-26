//go:build windows || bindings

package main

import (
	"embed"
	"os"
	"path/filepath"
	"github.com/hctty27/openshell/internal/branding"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"log"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
    // Prefer checked-in release helper binaries next to the application.
    if executable, err := os.Executable(); err == nil {
        helperDir := filepath.Join(filepath.Dir(executable), "zmodem")
        helpers := []string{"rz.exe", "sz.exe", filepath.Join("native", "rz.exe"), filepath.Join("native", "sz.exe"), filepath.Join("native", "msys-2.0.dll")}
        complete := true
        for _, name := range helpers {
            info, err := os.Stat(filepath.Join(helperDir, name))
            if err != nil || info.IsDir() { complete = false; break }
        }
        if complete {
            _ = os.Setenv("PATH", helperDir+string(os.PathListSeparator)+os.Getenv("PATH"))
        }
    }
    app, e := NewApp()
	if e != nil {
		log.Fatal("无法初始化应用：", e)
	}
	app.emit = func(name string, payload any) { runtime.EventsEmit(app.ctx, name, payload) }
	app.pickBackupRead = func() (string, error) {
		return runtime.OpenFileDialog(app.ctx, runtime.OpenDialogOptions{
			Title: app.dialogTitle("Import OpenShell session backup", "导入 OpenShell 会话备份"),
			Filters: []runtime.FileFilter{{DisplayName: app.dialogTitle("OpenShell backup (*.json)", "OpenShell 备份文件 (*.json)"), Pattern: "*.json"}},
		})
	}
	app.pickBackupWrite = func() (string, error) {
		return runtime.SaveFileDialog(app.ctx, runtime.SaveDialogOptions{
			Title: app.dialogTitle("Back up OpenShell sessions", "备份 OpenShell 会话"),
			DefaultFilename: "openshell-sessions.json",
			Filters: []runtime.FileFilter{{DisplayName: "OpenShell session backup (*.json)", Pattern: "*.json"}},
		})
	}
	app.pickImport = func() (string, error) {
		title := app.dialogTitle("Import Xshell sessions", "导入 Xshell 会话")
		return runtime.OpenFileDialog(app.ctx, runtime.OpenDialogOptions{
			Title: title,
			Filters: []runtime.FileFilter{{DisplayName: app.dialogTitle("Xshell sessions (*.xts;*.xsh)", "Xshell 会话文件 (*.xts;*.xsh)"), Pattern: "*.xts;*.xsh"}},
		})
	}
	app.pickKey = func() (string, error) {
		title := app.dialogTitle("Choose SSH private key", "选择 SSH 私钥")
		return runtime.OpenFileDialog(app.ctx, runtime.OpenDialogOptions{Title: title})
	}
	e = wails.Run(&options.App{Title: branding.Name, Width: 1440, Height: 900, MinWidth: 1000, MinHeight: 640, AssetServer: &assetserver.Options{Assets: assets}, BackgroundColour: &options.RGBA{R: 11, G: 16, B: 23, A: 255}, DragAndDrop: &options.DragAndDrop{EnableFileDrop: true, DisableWebViewDrop: true}, OnStartup: app.startup, OnBeforeClose: app.beforeClose, OnShutdown: app.shutdown, Bind: []interface{}{app}})
	if e != nil {
		log.Fatal(e)
	}
}
