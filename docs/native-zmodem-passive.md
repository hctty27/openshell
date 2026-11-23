# 原生 ZMODEM：远端主动握手自动接管

## 适用范围

对标 Xshell 的 **远端主动触发** 路径，不依赖 OpenShell 本地逐字跟踪的 `rz/sz` 命令行。Windows 正式版在原生 sidecar 可用时默认启用；其他平台需设置 `OPENSHELL_NATIVE_ZMODEM_SIDECAR` 指向 sidecar。

- 远端 `sz` 发送 CRC 正确的 ZHEX `ZRQINIT` → OpenShell 弹出本地保存目录选择器 → Rust 原生接收。
- 远端 `rz` 发送 CRC 正确的 ZHEX `ZRINIT` → OpenShell 弹出本地文件选择器 → Rust 原生发送。
- 仍坚持单文件；不恢复 `trzsz-go` 兼容引擎，不额外建立 SSH 会话，也不重发 `rz/sz` 命令。
- 对远端 `rz` 的参数未知时，用户必须额外勾选远端覆盖风险确认。

连接后，只要当前会话有有效的 Rust sidecar、SSH PTY 和可信的连接代际，并且不处于 JumpServer 菜单、交互 REPL、其他传输任务或终端 AI 独占状态，就会启用被动接管。

OpenShell 仍然优先截获直接键入的 `rz` / `sz file` 字面量命令。历史命令、Shell 脚本、`bash -c 'sz /tmp/test.bin'` 或复合命令会由远端自己发出握手，客户端不会替远端重建命令。

## Bash 恢复

自动初始化需要普通交互式 Bash 提示符。安装期间独占 SSH 输入，防止普通命令或终端 AI 误向 nonce 读取位置写入数据。

安装前先发送一行以空格开头的探测命令（`printf` 回显 `$BASH_VERSION`），探测期间的输出暂存不显示：只有回答了非空 Bash 版本才发送引导命令；zsh、dash、fish 等非 Bash Shell 或没有回答时，安静地回退到普通会话，不锁定终端。引导命令同样以空格开头，就绪前用 `history -d` 删掉探测和引导两条历史记录，回显在就绪后整行清除。若引导已发出却没有完成挑战/确认，客户端发送 Ctrl-C 中断，并回退到普通会话（这次连接不启用恢复）。成功安装后仍需远端真正发起 `rz/sz` 才会开始传输。

实现见 `native_zmodem_passive_bash_hook.go`、`runPassiveVerified` 与连接级安装器：

1. 仅适用于事先确认的交互式 Bash；远端命令开始前，客户端必须取得当前 SSH PTY 的控制权并执行钩子引导。
2. 引导命令不直接包含 nonce。Bash 输出挑战 OSC 后使用 `read -r -s` 无回显读取客户端后续单独发送的 128-bit 随机令牌，然后确认钩子准备就绪；保留已有标量/数组 `PROMPT_COMMAND` 行为。
3. Bash 在下次主提示符前输出带会话令牌与退出码的自定义 OSC。独立验证器要求已注册的令牌匹配当前会话；即使 Rust sidecar 先结束，仍然保留标记解析器并停止向 Rust 管道写入。
4. 接收到匹配令牌并确认 Rust 协议成功后，`terminalOutputGate` 在同一互斥锁中重新激活普通终端输出并回放尾部字节，然后 `terminalInputGate` 清除被动输入锁。错误令牌、缺少标记、超时和文件接收不完整时保持隔离。

**限制：** 该随机令牌用于识别预先安装的 Shell 钩子，不是对恶意远端服务器或同一账号恶意进程的身份认证。裸 OSC 133/633、Shell 提示符和单独 ZFIN 仍不允许解锁。非 Bash、钩子未完成或传输未验证结束时，终端页内显示原因和「重新连接」按钮，不会自动断开 SSH，也不会切到本地终端。

## 核心字节所有权

1. SSH 输出始终由单一 `terminalOutputGate` 写入；无第二个并发 PTY 读取者。
2. 被动保护层扫描 `ZRQINIT` / `ZRINIT`（ZHEX、CRC-16/XMODEM）；发现后立即封锁普通键盘输入。
3. 在文件选择期间只缓存最多 **1 MiB** 的原始协议数据。错误 CRC 仍隔离，缓冲溢出、连接断开或取消选择均保持 fail-closed。
4. 每次自动选择都有 SSH generation + selectionId；用户确认后，由 Manager 验证方向、选择所有权和唯一任务权限。
5. Rust sidecar 必须先启动，随后由输出门在同一把锁内先交付全部缓存，再允许后续 SSH 输出；没有任何字节落到 xterm。
6. 只有单一任务可以写入当前 SSH PTY 的原生控制帧。进度与文件元信息继续由现有传输中心展示。

## 协议结束后的独立输出隔离

远端的最后一个 ZMODEM 帧可能和随后 Shell 提示符出现在同一 SSH 输出流中。Rust sidecar 退出之后，客户端不能继续把后续数据写入已经结束的协议输入管道，更不能直接把这些数据发送给 xterm。

现在在 `terminalOutputGate` 的同一把锁下，把当前原生输出消费者切换为 `io.Discard`，**保留独占 lease、SSH PTY 和输入锁**。后续数据只会被安全丢弃；即使 Rust 退出后收到普通 Shell 提示符、裸 `OSC 133;D` / `OSC 633;D`，都不会解锁终端。错误或取消路径同样处理；过期 lease 无法替换当前的输出所有权。

仅在钩子状态确认后，才允许依据匹配会话令牌与 Rust 协议完成情况恢复同一 PTY；未注册路径仍使用独立隔离通道。

## 远端 Shell 退出尚不可验证时的行为

**未提前注册 Shell 集成的远端命令，仍然没有可靠的、与该会话关联的退出证明。**

- Rust sidecar 完成意味着本地 ZMODEM 协议结束，不等于远端 Shell 已经退出。
- 未完成 Bash 钩子注册的被动传输，即使协议成功，也**不会自动释放终端输入/输出独占权**；必须重新连接。终端页内会显示原因横幅和「重新连接」按钮，不再自动断开 SSH，也不会切到本地终端。
- 钩子已安装但传输在嵌套 Shell（`sudo -i`、`bash -l` 等）里完成、等不到结束标记时，Rust 已校验完成的下载文件会照常保存，只是终端需要重新连接。
- 远端 `sz` 只发 ZRQINIT 却不发文件（例如文件不可读），或远端 `rz/sz` 在选择器打开期间已经退出时，sidecar 在 15 秒握手超时后结束，不再等满 90 秒空闲超时。
- 选择下载目录时先检查本地目录可写，不可写时在选择器内提示，不会接管终端。
- 远端 `rz` 拒收（同名文件或目录不可写）时弹出通知，失败记录保留在传输中心。
- 提示符无法确认或复合命令（如 `cd x && sz f`）里的 `rz/sz` 不再被 typed 拦截直接拒绝，交给被动接管处理；多文件与不支持的参数仍然拒绝。
- 上传使用 256 个 1 KiB 子包的流式窗口（可用 `OPENSHELL_ZMODEM_STREAMING_WINDOW` 调整），高延迟链路上传速度不再受每个 RTT 约 10 KiB 的限制。预先确认 Bash 钩子、校验 nonce 且 Rust 协议完成的成功路径才允许恢复同一 PTY。
- 成功下载仅在 Rust sidecar 返回成功后发布本地临时文件；失败时不发布不完整文件。
- 用户取消文件选择时，远端传输可能仍在运行；为避免协议字节泄漏，不恢复原终端。
- 远端已启动但用户未完成选择时，选择请求在 **2 分钟**后自动超时；取消、超时、拒绝接管都会丢弃本地协议缓存，但不会恢复未经远端退出证明的终端。旧 selectionId/旧 SSH generation 的超时不会影响新任务。
- 普通的 OSC 133;D 或 OSC 633;D 仅是 Shell 集成的命令结束提示，**不是**与当前任务绑定的认证凭证；还没有建立可信会话/任务标记时，不能以这些序列自动解锁。
- 不允许用固定延迟、Shell 提示符文本或本地 Rust 进程退出代替远端完成证明。

参考：[用户指南](user-guide.md)；[Xshell 8 Manual](https://www.xshell.com/docs/Xshell8_manual.pdf)；[ZMODEM Protocol Wiki](https://github.com/TeraTermProject/teraterm/wiki/ZMODEM-Protocol)。
