//go:build !windows && !bindings

package main

import "fmt"

func main() {
	fmt.Println("OpenShell 第一版为 Windows 桌面应用；此系统仅支持运行核心测试和交叉编译。")
}
