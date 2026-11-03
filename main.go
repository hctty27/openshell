//go:build windows || bindings

package main

import (
	"embed"
	"os"
	"path/filepath"
	"github.com/hctty27/openshell/internal/branding"
	"github.com/wailsapp/wails/v3/pkg/application"
  "github.com/wailsapp/wails/v3/pkg/events"
  "context"
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
    service, err := NewApp()
    if err != nil { log.Fatal("无法初始化应用：", err) }
    ctx, cancel := context.WithCancel(context.Background())
    service.startup(ctx)
    desktop := application.New(application.Options{
      Name: branding.Name,
      Services: []application.Service{application.NewService(service)},
      Assets: application.AssetOptions{Handler: application.BundledAssetFileServer(assets)},
      ShouldQuit: func() bool { return !service.beforeClose(ctx) },
      OnShutdown: func() { cancel(); service.shutdown(ctx) },
    })
    service.emit = func(name string, payload any) { desktop.Event.Emit(name, payload) }
    service.quit = desktop.Quit
    service.pickBackupRead = func() (string, error) {
      return desktop.Dialog.OpenFile().SetTitle(service.dialogTitle("Import OpenShell session backup", "导入 OpenShell 会话备份")).
        AddFilter("OpenShell backup (*.json)", "*.json").PromptForSingleSelection()
    }
    service.pickBackupWrite = func() (string, error) {
      return desktop.Dialog.SaveFile().
        SetFilename("openshell-sessions.json").AddFilter("OpenShell backup (*.json)", "*.json").PromptForSingleSelection()
    }
    service.pickImport = func() (string, error) {
      return desktop.Dialog.OpenFile().SetTitle(service.dialogTitle("Import Xshell sessions", "导入 Xshell 会话")).
        AddFilter("Xshell sessions (*.xts;*.xsh)", "*.xts;*.xsh").PromptForSingleSelection()
    }
    service.pickKey = func() (string, error) {
      return desktop.Dialog.OpenFile().SetTitle(service.dialogTitle("Choose SSH private key", "选择 SSH 私钥")).PromptForSingleSelection()
    }
    service.pickDirectory = func() (string, error) {
      return desktop.Dialog.OpenFile().SetTitle(service.dialogTitle("Select local folder", "选择本地文件夹")).
        CanChooseDirectories(true).CanChooseFiles(false).PromptForSingleSelection()
    }
    window := desktop.Window.NewWithOptions(application.WebviewWindowOptions{
      Name: "main", Title: branding.Name, Width: 1440, Height: 900,
      MinWidth: 1000, MinHeight: 640, Frameless: true, EnableFileDrop: true,
      BackgroundColour: application.NewRGB(11,16,23),
      Windows: application.WindowsWindow{NonClientRegionSupport: true},
    })
    // A WindowClosing hook must cancel the native close before WebView2 is destroyed.
    // ShouldQuit alone runs too late for the frontend to display its confirmation.
    window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
      if service.beforeClose(ctx) {
        event.Cancel()
      }
    })
    window.OnWindowEvent(events.Common.WindowFilesDropped, func(event *application.WindowEvent) {
      details := event.Context().DropTargetDetails()
      if details == nil { return }
      desktop.Event.Emit("app:files-dropped", map[string]any{
        "x": details.X, "y": details.Y, "paths": event.Context().DroppedFiles(),
      })
    })
    if err := desktop.Run(); err != nil { log.Fatal(err) }
}
