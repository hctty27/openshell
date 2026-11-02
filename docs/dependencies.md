# 依赖与构建

- **Go 1.26.10**：CI 与正式构建统一使用该安全修复版本；参见 [Go 发行说明](https://go.dev/doc/devel/release)。
- **Wails v3.1.0**：Go 模块、CLI 与 `@wailsio/runtime` 必须保持同一正式版本；参见 [Wails 发布策略](https://wails.io/contributing/release-policy/)。
- **Windows WebView2**：使用操作系统提供的 WebView2 Runtime；本地回退终端依赖 ConPTY。
- Go 依赖准确版本见 `go.mod` / `go.sum`；前端准确版本见 `frontend/package.json` / `frontend/package-lock.json`。
- 通过锁文件进行可复现构建；发布流程不执行未经审核的自动依赖升级。
