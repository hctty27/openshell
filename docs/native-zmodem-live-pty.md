# PR #215 — 原生 ZMODEM 与交互式 SSH 终端生命周期

## 本阶段

- 原生传输任务与完整 `ConnectionRef` 绑定；只允许同一连接代际的操作取消它，防止重连后的旧任务影响新标签页。
- `Manager` 的断开、CancelTab、重连、Close、keepalive 失败以及 SSH transport/terminal 退出路径均会主动取消任务；不在持有 `Manager.mu` 时等待 Rust 子进程退出。
- 原生任务与已存在的 AI 终端 lease、旧版 `rz/sz` 传输互斥。常规用户输入依旧走 `trzsz-go`，没有新增 Wails/UI 调用入口。
- 若原生协议失败或取消后输入 gate 仍处于独占状态，则设置连接级 `nativeTerminalPoisoned`；即使任务退出，也禁止新的 AI lease 或原生任务，直到重连生成新的连接代际，避免失败后的半接管终端被重用。
- 新增 `TestNativeZmodemTerminalLifecycle...`，使用真实测试 SSH 服务模拟取消、断线、重连、终端结束和过期连接引用。

## 真实交互式 PTY 测试

- CI 在 Linux runner 上启动 OpenSSH daemon，并使用已编译的 Rust `zmodem-sidecar` 和系统 `lrzsz`。
- 新增 `TestNativeZmodemLiveInteractivePTY`：真实 `ssh.Session.Shell()` + `Manager.OpenTerminal` + 同一 PTY 的独占输入输出路由 + 远端 nonce-bound 完成标记。此测试不同于此前单独 SSH exec Session 的 ZMODEM 互操作。
- 上传和下载验证：0 字节、约 64 KiB 二进制、中文文件名，验证 SHA-256；多次传输复用同一个交互式 Shell 并检查普通键盘输入能够恢复。
- 使用固定 SSH Host Key 和临时测试凭据。上传目标会落在 GitHub Runner 用户的 HOME 下，使用唯一文件名，测试结束清理；不使用任何真实服务器或私钥。

## 未完成

- 只有 Linux runner 上的真实交互式 Shell/PTY 可以证明当前实验路径；不能据此宣称 Windows 原生 Go + Rust 在真正的 Linux PTY 上通过。
- 不在 Wails 层公开原生交互式传输入口；不替换默认 `rz/sz`、`trzsz-go`，不移除 MSYS2，也不发布新版本。
- 必须继续覆盖大文件、弱网、远端 shell 差异、用户关闭弹窗后的回退行为和 Windows↔Linux 真机测试。
