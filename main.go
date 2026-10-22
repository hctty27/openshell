//go:build windows || bindings

package main

import (
	"embed"
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
	app, e := NewApp()
	if e != nil {
		log.Fatal("无法初始化应用：", e)
	}
	app.emit = func(name string, payload any) { runtime.EventsEmit(app.ctx, name, payload) }
	app.pickKey = func() (string, error) {
		language, err := app.language()
		if err != nil {
			return "", err
		}
		title := "Choose SSH private key"
		if language == "zh-CN" {
			title = "选择 SSH 私钥"
		}
		return runtime.OpenFileDialog(app.ctx, runtime.OpenDialogOptions{Title: title})
	}
	e = wails.Run(&options.App{Title: branding.Name, Width: 1440, Height: 900, MinWidth: 1000, MinHeight: 640, AssetServer: &assetserver.Options{Assets: assets}, BackgroundColour: &options.RGBA{R: 11, G: 16, B: 23, A: 255}, DragAndDrop: &options.DragAndDrop{EnableFileDrop: true, DisableWebViewDrop: true}, OnStartup: app.startup, OnShutdown: app.shutdown, Bind: []interface{}{app}})
	if e != nil {
		log.Fatal(e)
	}
}
