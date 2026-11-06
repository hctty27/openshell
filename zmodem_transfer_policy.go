package main

import "runtime"

const (
	zmodemModeNative = "native"
	zmodemModeLegacy = "legacy"
)

// 默认仅在 Windows 优先原生单文件 ZMODEM，其余平台保持原实现。
// 用户明确保存的设置总是覆盖默认值。
func resolveZmodemTransferMode(raw string) string {
	switch raw {
	case zmodemModeNative, zmodemModeLegacy:
		return raw
	default:
		if runtime.GOOS == "windows" {
			return zmodemModeNative
		}
		return zmodemModeLegacy
	}
}

func (a *App) nativeZmodemPreferred() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.zmodemTransferMode == zmodemModeNative
}
