# OpenShell 原生 ZMODEM 传输管理器（非发布实验）

## 范围

在 PR #204、#205、#206 的 Rust、Linux lrzsz 和真实 SSH PTY 验证基础上，将原生传输桥接下沉到 Go SSH 管理层。**本阶段仍然不接管已有交互终端的 PTY，也不改动 trzsz-go / lrzsz-win32 / MSYS2 / 正式 rz/sz 路径。**

### 架构

- `NativeZmodemManager` 根据 `ConnectionRef` 取得 OpenShell 当前已认证的 `*ssh.Client`；不二次认证，也不重用已有终端的 SSH Session。
- 为每次传输开独立 `ssh.Session` + PTY，启动远端 `rz` / `sz`，以原始字节流桥接 Rust `zmodem-sidecar`。命令行、终端历史、AI、trzsz filter 都不消费该流。
- `upload`：本地单文件 → Rust `send` → 远端 `rz -q`；默认不覆盖远端同名文件。
- `download`：远端 `sz -q` → Rust `receive` → 本地私有临时目录，SHA/协议完整性由 sidecar 与现有互操作测试覆盖；完成后以文件硬链接原子发布到目标目录且不允许覆盖已有文件。
- 每个 SSH 标签页同一时刻最多一个原生传输。取消和连接断开事件会取消对应任务；90 秒实验超时内退出。不对失败的传输做流内自动回退。
- 提供后端（非 UI）方法 `StartExperimentalNativeZmodem` 和 `CancelExperimentalNativeZmodem`，同时通过 `ssh:native-zmodem-state` 发送独立生命周期事件。

### 实验启用

生产包不会包含 sidecar，默认管理器被禁用。仅在本地开发时设置：

```powershell
$env:OPENSHELL_NATIVE_ZMODEM_EXPERIMENT = "1"
$env:OPENSHELL_NATIVE_ZMODEM_SIDECAR = "C:\path\to\zmodem-sidecar.exe"
```

启动时读取这两个变量。传输参数：`{ref, direction: "upload"|"download", localPath, remotePath}`。上传的 `remotePath` 是远端**目录**；下载是远端**文件**；本地路径相反。当前不增加 UI 按钮，也不自动拦截终端输入的 `rz/sz`。

### 测试

- `go test -race ./internal/ssh`：方向及远端路径转义、本地文件类型/大小、并发互斥、失效 `ConnectionRef` 取消隔离、临时目录清理、安全落盘及不覆盖文件。
- Windows CI 另行运行 `go test -run '^TestNativeZmodem' ./internal/ssh`。
- 原 `experiments/native-zmodem/ssh-pty-bridge` 的入口已改为使用本模块的 `RunNativeZmodemTransport`，所以原 Linux SSH PTY 真实传输 10/10 与系统 lrzsz 互操作测试验证的是**同一个 Go 二进制传输核心**。
- Linux CI 的 SSH 实验和 Windows Rust sidecar 测试仍保留。

## 当前限制

1. 这并不是在用户已打开的 SSH 终端中使用原生 ZMODEM；独立 Session 不继承交互式 Shell 的当前目录、环境或 JumpServer 菜单，JumpServer 明确拒绝。
2. 不支持多文件、目录、断点续传；单文件上限 128 MiB。sidecar 自身会话超时也保持 90 秒。硬链接安全发布依赖目标文件系统支持同卷硬链接，暂不承诺所有 Windows 文件系统都可用。
3. 本阶段未完成 Windows Go+Rust 经 SSH PTY 的真实远端双向联调、弱网、重传、异常关机和文件占用测试；也未完成发布版 sidecar 打包与许可证/来源审查。
4. 若在传输中失败，不得尝试使用另一个协议处理器继续解释同一条 ZMODEM 字节流；回退只能发生在**下次**传输开始之前。
5. sidecar 的 stderr 不写入传输通道，但有限的调试错误可反馈给开发端。禁止输出用户文件内容或私钥。

**结论：这是一项开发者手动启用的 Go 后端集成，不属于完成正式版切换。下一阶段应在 Windows Runner 中对实际 Go 管理器与 Rust EXE 的 SSH PTY 联调，并设计用户终端 PTY 的单一数据消费者移交机制。**

## PTY 与 SSH exec 阶段的超时防护

此前仅 SSH `NewSession()` 使用了异步等待和取消控制。假如远程 SSH 服务端接受新 Session，却不回复 `pty-req` 或 `exec` 请求，原生传输管理器可能在真正启动 sidecar 前永久挂起。

目前 `RunNativeZmodemTransport` 对创建 Session、`RequestPty` 和 `session.Start` 都实施同一传输 `context` 的取消与截止时间约束：

- 取消时关闭本次**独立** SSH Session，不关闭共享 SSH Client 或当前可见终端。
- 若远端一直不回应 PTY 或执行请求，立即返回可以通过 `errors.Is(err, context.DeadlineExceeded)` 识别的错误。
- 新测试服务端模式 `pty-hang` 模拟不回复 PTY 请求；原 `start` 模式模拟不回复 exec 请求；`open` 模式模拟不接受新 SSH Channel。以上三个阶段均受截止时间控制。
- 下载到临时目录过程中发生取消、管理器关闭或超时，必须清理未完成文件与目录，释放活跃任务记录。
- Windows 和 Linux SSH 回归测试都运行这些 Go 用例。它们检查异常生命周期，不等于已完成公网弱网模拟、真实 Windows→Linux Linux PTY 端到端测试或交互终端流接管。
