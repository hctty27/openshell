# 原生 ZMODEM：远端主动握手自动接管（实验功能）

## 适用范围

对标 Xshell 的 **远端主动触发** 路径，不依赖 OpenShell 本地逐字跟踪的 `rz/sz` 命令行。

- 远端 `sz` 发送 CRC 正确的 ZHEX `ZRQINIT` → OpenShell 弹出本地保存目录选择器 → Rust 原生接收。
- 远端 `rz` 发送 CRC 正确的 ZHEX `ZRINIT` → OpenShell 弹出本地文件选择器 → Rust 原生发送。
- 仍坚持单文件；不恢复 `trzsz-go` 兼容引擎，不额外建立 SSH 会话，也不重发 `rz/sz` 命令。
- 对远端 `rz` 的参数未知时，用户必须额外勾选远端覆盖风险确认。

## 实验开关

**默认关闭。仅在非生产、可随时重新连接的 SSH 测试会话开启。**

在 Windows PowerShell 中启动 OpenShell 前设置：

```powershell
$env:OPENSHELL_ZMODEM_PASSIVE_EXPERIMENT = "1"
.\OpenShell.exe
```

仅设置开关并不保证接管：当前会话必须具有有效的 Rust sidecar、SSH PTY、可信的连接代际，并且不能处于 JumpServer 菜单、交互 REPL、其他传输任务或终端 AI 独占状态。

OpenShell 仍然优先截获直接键入的 `rz` / `sz file` 字面量命令。测试被动模式时，可在普通 Linux Shell 内用历史命令、Shell 脚本或 `bash -c 'sz /tmp/test.bin'` 触发**远端**发送，确认客户端没有替远端重建命令。

## 核心字节所有权

1. SSH 输出始终由单一 `terminalOutputGate` 写入；无第二个并发 PTY 读取者。
2. 被动保护层扫描 `ZRQINIT` / `ZRINIT`（ZHEX、CRC-16/XMODEM）；发现后立即封锁普通键盘输入。
3. 在文件选择期间只缓存最多 **1 MiB** 的原始协议数据。错误 CRC 仍隔离，缓冲溢出、连接断开或取消选择均保持 fail-closed。
4. 每次自动选择都有 SSH generation + selectionId；用户确认后，由 Manager 验证方向、选择所有权和唯一任务权限。
5. Rust sidecar 必须先启动，随后由输出门在同一把锁内先交付全部缓存，再允许后续 SSH 输出；没有任何字节落到 xterm。
6. 只有单一任务可以写入当前 SSH PTY 的原生控制帧。进度与文件元信息继续由现有传输中心展示。

## 协议结束后的独立输出隔离（PR #296）

远端的最后一个 ZMODEM 帧可能和随后 Shell 提示符出现在同一 SSH 输出流中。Rust sidecar 退出之后，客户端不能继续把后续数据写入已经结束的协议输入管道，更不能直接把这些数据发送给 xterm。

现在在 `terminalOutputGate` 的同一把锁下，把当前原生输出消费者切换为 `io.Discard`，**保留独占 lease、SSH PTY 和输入锁**。后续数据只会被安全丢弃；即使 Rust 退出后收到普通 Shell 提示符、裸 `OSC 133;D` / `OSC 633;D`，都不会解锁终端。错误或取消路径同样处理；过期 lease 无法替换当前的输出所有权。

新增了内存并发回归（最后一批协议输出与隔离切换竞争）、sidecar 失败后的隔离断言，以及真实 Linux OpenSSH 自动接管 E2E 的 PTY 存活检查。

下一步要做的不是使用固定延迟或裸 OSC 自动调用 `restore()`，而是先在 **远端命令启动之前** 建立可信的 Shell 集成，并将独立的会话/命令随机标识绑定到其完成消息。当前仍未实现该预先绑定机制，因此默认关闭自动恢复。

## 关键限制：远端 Shell 退出尚不可验证

**远端主动启动的命令没有 OpenShell 预先植入的 nonce-scoped shell 退出标记。**

- Rust sidecar 完成意味着本地 ZMODEM 协议结束，不等于远端 Shell 已经退出。
- 因此此实验路径即使文件传输成功，也**不会自动释放终端输入/输出独占权**。用户必须重新连接 SSH 才能继续普通命令。
- 成功下载仅在 Rust sidecar 返回成功后发布本地临时文件；失败时不发布不完整文件。
- 用户取消文件选择时，远端传输可能仍在运行；为避免协议字节泄漏，不恢复原终端。
- 远端已启动但用户未完成选择时，选择请求在 **2 分钟**后自动超时；取消、超时、拒绝接管都会丢弃本地协议缓存，但不会恢复未经远端退出证明的终端。旧 selectionId/旧 SSH generation 的超时不会影响新任务。
- 普通的 OSC 133;D 或 OSC 633;D 仅是 Shell 集成的命令结束提示，**不是**与当前任务绑定的认证凭证；还没有建立可信会话/任务标记时，不能以这些序列自动解锁。
- 不允许用固定延迟、Shell 提示符文本或本地 Rust 进程退出代替远端完成证明。

这意味着它是远端握手识别与原生传输交接的**功能性实验**，不是完整达到 Xshell 交互体验的最终实现。要自动恢复原终端，还必须完成经过授权的 Shell 集成（例如支持的 OSC 133/633 命令结束事件）、结束状态证明及完整回归验证。

## 实机验收要求（合并/默认启用前）

- Ubuntu 22/24、Rocky 9、CentOS 7，已安装 Linux `lrzsz`；远端主动发送/接收、单文件空文件、中文文件名、4 MiB / 16 MiB / 1 GiB。
- 反复选择和取消、缓冲超限、发送端超时、远端权限不足、sidecar 缺失、进度末尾、SSH 网络断连。
- 同时打开多个 SSH Tab、不同连接代际、远端帧拆包、异常 CRC、Redis/MySQL/Python/JumPServer/全屏程序。
- 弱网延迟和丢包注入下至少 100 次混合往返；记录文件 SHA-256、进度结果、UI 锁定以及重新连接行为。
- 未完成且未经实际验证前不合入默认行为，不发布正式版。

参考：[Xshell 8 Manual](https://www.xshell.com/docs/Xshell8_manual.pdf)；[ZMODEM Protocol Wiki](https://github.com/TeraTermProject/teraterm/wiki/ZMODEM-Protocol)。
