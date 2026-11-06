package main

import (
	"os"
	"runtime"
)

const (
	zmodemModeNative = "native"
	zmodemModeLegacy = "legacy"
)

// Windows 固定使用 Rust 原生引擎；其他平台保持各自支持的兼容实现。
// 旧版本保存的 zmodemTransferMode 仅作为历史数据，不再影响运行策略。
func resolveZmodemTransferMode(_ string) string {
	if runtime.GOOS == "windows" || os.Getenv("OPENSHELL_NATIVE_ZMODEM_SIDECAR") != "" {
		return zmodemModeNative
	}
	return zmodemModeLegacy
}

func (a *App) currentZmodemTransferMode() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.zmodemTransferMode
}

func (a *App) nativeZmodemPreferred() bool {
	return a.currentZmodemTransferMode() == zmodemModeNative
}
