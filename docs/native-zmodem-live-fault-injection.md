# PR #217 — 真实 SSH PTY 原生 ZMODEM 故障注入

## 目的

原有 Linux CI 证明了 Rust sidecar 可以通过 `Manager.OpenTerminal` 与真实 Linux `lrzsz` 成功传输，并在 SSH 断开时取消模拟 sidecar。此次将两部分结合起来：**真实 OpenSSH 交互式 Shell、真实 Rust sidecar、真实 `sz` 和原生传输协调器**，验证传输途中断开。

## 场景

- 使用 SFTP 在隔离测试 Linux 用户的 HOME 里创建 32 MiB 原始文件。
- 创建**另一条独立的 SSH 连接**并开启真实交互式 PTY；用带有 8ms 延迟和 16KiB TCP 分块的客户端通道启动原生 ZMODEM 下载。
- 等待 SSH PTY **确实出现远端 ZMODEM 起始帧**，保证不是只在排队/初始化阶段就取消，然后分别执行 `CancelExperimentalNativeTerminalTransfer`、传输 Context 截止时间、关闭 SSH 传输。
- 验证原生任务及时退出、`ConnectionRef` 对应任务清空、旧终端保持不可自动恢复 (`nativeTerminalPoisoned`)、AI 与第二次原生传输不得占用该终端。
- 下载失败后不得发布不完整文件，阶段性 `.openshell-zmodem-terminal-*` 临时目录必须清理。
- 对主动取消/超时场景，认证后的同一 SSH 客户端仍可创建独立 SFTP 通道，证明取消本地 sidecar 不会错误关闭共享 SSH Client。故意关闭 SSH 连接的场景不做此断言。
- 在单独的第三条 SSH 连接上执行 SFTP 文件清理，确保断线场景也可以清理测试文件。

## 测试约束与注意事项

- CI 使用 Linux 客户端连接 Linux OpenSSH；不等于 Windows 真机连接 Linux 的结果。代码可在 Windows Go 测试进程使用 Windows Rust sidecar 和专用 Linux OpenSSH/SFTP 测试账号复用。
- 此处的链路条件是**TCP 分块与延迟**，不模拟真实丢包、重传、拥塞或服务器不可达。
- 故障后不尝试盲目恢复旧协议流，必须创建新的 SSH 终端会话才能重新进行 AI 或原生传输。
- 默认正式 `rz/sz`、`trzsz-go`、MSYS2 和 Wails 客户端功能保持不变；测试不发布新版本。

## CI 执行

`native-zmodem-probe.yml` 在现有 Linux/OpenSSH `TestNativeZmodemCrossOSInteractivePTY` 之后运行 `TestNativeZmodemLiveInterruptedInteractivePTY`。该测试须观察完整结束状态并检查原生任务生命周期清理。
