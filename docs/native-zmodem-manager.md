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


## 已有交互式 SSH 终端的数据流独占门（实验基础）

终端输出路径新增 `terminalOutputGate`，位于 `ssh.Session.Stdout/Stderr` 和现有 `zmodemDirectionWriter` 之间：

```text
SSH interactive PTY stdout/stderr
  -> terminalOutputGate  [默认 legacy]
       +-- legacy -> zmodemDirectionWriter -> trzsz-go -> terminal history/UI
       +-- native -> 独占的原生协议字节接收器（本 PR 尚未启用）
```

- **默认无行为变更**：全部字节仍按原路径进入 `trzsz-go`；不改变 UI、文件选择、上传下载和原有传输工具。
- `takeover(native io.Writer)` 在前一次 `Write` 完毕后原子切换输出消费者；期间同一字节不会同时发送给 legacy 与 native。
- `restore(lease)` 要求当前的独占令牌，旧任务无法替新任务恢复输出；**必须在原生协议双端完成并清空缓冲后显式调用**。
- 当 native sink 写入失败时保持 native 所有权，禁止自动将后续协议字节送至终端历史/UI。
- 关闭终端即关闭 gate，禁止继续接收数据或恢复过期租约。
- `takeover` **不能**从下游 `zmodemDirectionWriter.Write` 的同步回调直接调用，因为切换需要等待现有 `Write` 退出。下一阶段必须先设计非阻塞、可无损保存已识别 ZMODEM 头帧的握手协议。

**未完成：** 本 PR 没有把 Rust sidecar 接到 gate 的 native 输出，也没有接管当前终端的标准输入；只完成输出流的单一消费者基础和隔离测试。输入方向、缓冲/头帧、取消、异常恢复与真实交互式 `rz/sz` 尚未通过端到端验收，因此不应对外开放切换。


## ZMODEM 启动帧无损识别（实验基础）

新增 `nativeZmodemStartScanner` 和 `terminalOutputGate.armOnZmodemHeader`，针对现有 ZMODEM 检测器使用的 `**\\x18B0[01][0-9a-f]{12}` 十六进制帧头（18 字节）实现分块识别。

- 只有显式调用 `armOnZmodemHeader(native io.Writer)` 时才进行缓存、协议头识别和切换；**正式 OpenShell 不调用该方法**，旧版 `rz/sz`、文件选择和终端数据流完全按原样运行。
- 最多暂存 17 字节候选帧前缀；非匹配字节原样进入旧过滤器。若帧头在两个或多个 SSH 输出块间拆分，不会提前向 `trzsz-go` 发送候选协议字节。
- 命中完整帧头时，在同一写锁下将之前的普通终端文本送入旧过滤器，完整帧头和该块中后续全部原始字节送入 native sink；之后全部后续字节只进入 native。
- 若尚未识别到完整帧头，调用 `disarm(lease)` 可以将暂存的候选字节完整还给旧过滤器，不丢失普通终端输出。
- 一旦命中 native，必须等原生协议双端已经完成并清空队列才能 `restore(lease)`。native 写入失败后不允许隐式回退；不能让错误的协议尾字节泄漏至终端渲染器或 AI 历史。
- 新增测试覆盖所有单次分割点、逐字节拆分、假帧头、不完整帧头、非 UTF-8 二进制负载、大数据量缓存界限、旧过滤器旁路和失效租约。

**关键剩余工作：** 当前仅具有“预置接收者后的原子输出切换”能力，尚未实现输入方向的 SSH PTY 所有权切换，也未提供实际 Rust sidecar 的已连接启动与主动文件选择；不支持在终端输入 `rz/sz` 时直接接管。不能直接在 `zmodemDirectionWriter.Write` 的同步回调中执行 `arm`，否则会导致死锁。真实用户交互需要下一阶段设计 sidecar 就绪、输入/输出同步移交以及明确的取消恢复状态机。


## PR #212：终端输入独占及 Rust sidecar 生命周期（基础能力）

新增 `terminalInputGate`，与已合并的 `terminalOutputGate` 形成双向流所有权基础：

```text
用户键盘 / AI -> terminalInputGate -> trzsz-go -> SSH PTY stdin  [默认 legacy]
                      | 进入 native lease 后拒绝手动输入
Rust sidecar stdout -> nativeTerminalProtocolWriter(lease) -> SSH PTY stdin

SSH PTY stdout/stderr -> terminalOutputGate -> trzsz-go / 预置 native 接收器
```

- `connection.stdin` 现在默认指向 `terminalInputGate`，但仍无条件透传旧过滤器；`connection.inputGate` 保存该实例。只有显式获取 `takeover()` 租约后才阻止用户和 AI 的写入。
- 使用 `writeNative(lease, p)` 将 sidecar 原始二进制响应直接送进已打开的 SSH PTY 的底层输入管道，**不经 `trzsz-go`**。过期或错误的租约不得发送字节。
- 租约切换与写入由同一互斥锁串行化；旧版正在写入时不会半路混入原生二进制响应。
- `Manager.Write` 仅在终端写入成功后调用 `readiness.userInput`，避免被拦截的用户按键错误影响终端状态判断。
- `runNativeZmodemTerminalSidecar` 是开发态可复用的进程管理基础，启动 Rust `zmodem-sidecar send FILE` / `receive DIR`，将一条专用、可关闭的输入流转给进程 stdin，stdout 原样写回 native input lease；stderr 仅存储有限的调试信息，不混入协议数据。
- 取消或超时会杀掉专用 sidecar 子进程并关闭专用管道，不能关闭共享 SSH Client。测试用当前 Go 测试二进制模拟 sidecar，覆盖二进制原样传输、stderr 与 wire 隔离、非零退出、截止时间与旧租约。
- 输入 gate 默认不被任何原生任务接管。**尚未实现**将当前 `OpenTerminal` 的输出头帧准备、完整输入接管、sidecar 启动、接收目录选择、控制帧尾部排空与 SSH 终端恢复编排成一个可用的用户功能。

### 必须完成的端到端验收

1. 远端 `rz/sz` 的真实交互式会话从检测头帧到 Rust sidecar 完成，不能让任何协议字节进入终端历史/UI。
2. 租约获取顺序、失败回滚和异常清理必须由统一协调器管理；不能随意通过 `restore` 把未排空的尾帧送回旧过滤器。
3. 验证远端取消、关闭标签页、断线、文件选择取消、服务端不读输入的背压行为，以及 Windows 原生客户端连接 Linux OpenSSH PTY。
4. 未通过前继续保持旧 `rz/sz` 及 MSYS2，不发布或切换正式功能。

## PR #213：交互式 ZMODEM 双向接管协调器（仅实验、未启用）

在现有 `terminalInputGate`、`terminalOutputGate` 和 `runNativeZmodemTerminalSidecar` 基础上，新增 `nativeTerminalCoordinator`，提供明确授权且**尚未连接 Wails/UI** 的接管编排模型。

### 状态与顺序

1. 调用者明确选择操作方向和本地单文件（或下载目录），校验文件类型与 128 MiB 原型限制；下载先建立私有临时目录。不能凭远端输出自动启动传输。
2. 取得 `terminalInputGate` 独占租约，禁止键盘与 AI 输入混入协议流。
3. 调用 `terminalOutputGate.armOnZmodemHeader` 预置原生接收器，无损检测跨块头帧，防止旧 `trzsz-go` 抢读。
4. 启动 sidecar runner；它的初始输出由 `nativeTerminalOutboundBarrier` 暂停，直至收到匹配方向的远端 ZMODEM 帧头。上传需要 `ZRINIT` (01)，下载需要 `ZRQINIT` (00)。
5. 通过原生输入租约发送受约束的 Shell 命令：上传 `rz -q`（当前工作目录），下载 `sz -q -- '经 POSIX 引号转义的路径'`。不会使用 `exec` 替换交互式 Shell。
6. 命中后远端协议字节只进入 sidecar stdin，sidecar stdout 只进入 SSH PTY 的原生输入租约；普通文本仍走旧输出处理器。
7. **成功退出 sidecar 不代表远端 Shell 已恢复。** PR #214 已实现带随机令牌和远端退出状态的 Shell 完成标记解析，标记必须完整匹配后才允许恢复输出、输入，最后发布已下载的文件。
8. 发送命令后，若取消、方向不符、sidecar 失败或结束状态不明则 **fail closed**：不恢复旧路由；需要断开并重连这个终端，避免二进制尾帧泄漏。

### 限制与后续

- PR #214 已将旧的外部 `remoteDrained` 通道替换为内置远端 Shell 完成标记检测器；**尚未完成真实交互式 Windows→Linux 端到端联调和连接生命周期绑定**，协调器依旧没有 Wails/UI 调用方，不应在正式客户端启用。
- 18 字节 ZMODEM 启动帧检测只是握手识别，**不是身份认证，也不验证完整 CRC**。方向不符不释放 sidecar 的初始响应。
- 单文件 / 128 MiB 上限、POSIX Shell、缺少真实交互式 Windows→Linux 全链路验证；不支持 JumpServer、弱网和自动重试。
- 测试通过注入确定性的 sidecar runner 验证双向流所有权、完成屏障、取消后 fail-closed，以及成功后单文件安全发布。
- 原来的 `rz/sz`、`trzsz-go`、MSYS2、发行包完全不变。下一步实现可信结束边界检测、连接生命周期绑定以及实际 SSH PTY 联调。

## PR #214：远端 Shell 完成标记解析与原子终端恢复（实验）

- 每次传输通过 `crypto/rand` 生成 128-bit 随机令牌；Shell 命令在 `rz/sz` 返回后保存退出码，并使用 `printf` 输出专用 OSC 控制标记 `ESC]777;OpenShellNativeZmodem;<token>;<exit_code>BEL`。终端自身回显的 Shell 命令只包含可打印的反斜线转义，不会包含真实 ESC/BEL。
- 在 `terminalOutputGate` 的 native 接收器后加 `nativeRemoteBoundarySink`，扫描跨 SSH 输出块的完成标记。完成标记不会进入 ZMODEM sidecar；匹配之前的真实协议字节保持原样转发；匹配之后的 Shell 提示符/普通输出先缓存在 64 KiB 有界缓冲中。
- 只有本地 sidecar 成功、远端完成标记的令牌完全匹配且退出码为 0，才调用 `restoreWithReplay`。该操作在输出 gate 锁内回放尾随 Shell 输出并恢复旧路由，保证与并发 SSH 输出的严格先后顺序。
- 远端退出码非零、标记错误或缺失、缓冲溢出、取消或超时时持续保持 fail-closed，不会把未知协议字节送回 `trzsz-go`/历史/UI。
- 帧头和完成标记均为**可信 SSH 对端主动执行的命令边界标识，不是对恶意服务器的认证或 CRC 证据**。调用方仍必须明确授权和选择文件，不能仅凭输出自动启动协议。
- 本阶段仍没有正式调用入口；未绑入真实 SSH 标签页生命周期，未覆盖 JumpServer、异常重连、弱网及真实 Windows→Linux 的同一交互式 PTY。旧传输链路与 MSYS2 保持不变。
