# 原生 ZMODEM：直接输入 rz/sz 的实验性自动接管

> **仅开发者试用，不是正式版默认行为。** 此实现将用户在普通 Shell 中输入的简单命令转换为一次需要用户确认的原生 ZMODEM GUI 传输。它不做纯协议头帧的无授权自动接管，不删除 `trzsz-go` 或旧 `rz/sz`。

## 开关与启动

先使用包含 `zmodem/native/zmodem-sidecar.exe` 的 Windows 实验测试包。在 PowerShell 中进入 `OpenShell.exe` 目录，设置：

```powershell
$env:OPENSHELL_NATIVE_ZMODEM_EXPERIMENT = "1"
$env:OPENSHELL_NATIVE_ZMODEM_AUTO = "1"
.\OpenShell.exe
```

必须**同时**设置两个变量。只开启 `EXPERIMENT` 时仍通过原生实验按钮手动传输；不设置变量时所有直接输入的命令仍走旧 ZMODEM 路径。

## 支持的自动命令

在**普通 Bash/readline Shell 提示符**、会话空闲且 sidecar 就绪的情况下：

| 用户在终端输入 | 实际动作 |
| --- | --- |
| `rz` + Enter | 用 Ctrl-U 清除还未执行的终端输入；弹出原生上传 GUI。选择**单文件**，勾选实验风险确认，再开始原生上传 |
| `sz /tmp/example.bin` + Enter | 清除还未执行的命令，弹出原生下载 GUI，自动填入绝对远端文件路径。选择本地目录、勾选确认后再开始 |
| 其他命令 | 不更改输入，照常由远端 Shell/旧传输处理 |

**明确不自动接管**：`rz -y`、`sz relative.bin`、引用/空格/中文/转义路径、复合命令、多行粘贴、命令历史、行内编辑、未知提示符、JumpServer、MySQL/Python/Redis 交互程序、正在传输的会话。单文件上限和不覆盖同名文件规则仍与原生实验一致。

## 实现与安全边界

1. Go `Manager.Write` 在每个精确 `ConnectionRef` 上保留一份有界输入探测状态，不缓存或记录实际命令内容。只有首次输入前 `terminalShellReadiness.checkReady()` 确认普通 Shell 提示符才可能进入探测。
2. 探测只跟踪尚未按回车、未经过编辑的简单 ASCII 输入，最长 256 字节。所有其他输入均保持原样写往旧 `trzsz-go` 过滤器，避免影响正常终端。
3. 匹配命令时再次校验原生 sidecar、JumpServer 限制、当前代际及终端是否被 AI/旧传输占用。校验失败保留原始 Enter，交给旧处理器。
4. 校验通过后把最后的 Enter 替换为 Ctrl-U：**不让远端立即运行未加结束标记的命令**，只向 GUI 派发明确授权的方向/远端路径。用户取消弹窗不会启动传输。
5. 用户在 GUI 中再次确认后，仍由现有 `nativeTerminalCoordinator` 在**同一 SSH PTY** 上生成自己的受保护 Shell 命令，并等待远端随机结束标记后恢复；失败时按现有设计要求重连。
6. UI 事件绑定到原始 `ConnectionRef`，后端在真正开始前再次校验，不能让旧会话的事件触发新连接传输。

**局限**：此实现依赖远端 Bash/readline 的 Ctrl-U 行清除行为和保守的 Shell 提示符识别。极端 Shell 配置或伪装提示符可能使行编辑行为不符合预期，所以必须先在隔离测试机验收。此 PR 不是任意终端输出 `**\x18B0...` 都能触发的无条件自动接管。

## 验收流程

1. **无开关**：直接键入 `rz`/ `sz /tmp/example.bin` 仍由旧路径处理。
2. **仅 EXPERIMENT**：只有手动原生按钮；无自动拦截。
3. **双开关**：Bash 提示符执行 `rz`、`sz /tmp/example.bin`，弹出原生 GUI；传输结果与双方 SHA-256 相同。
4. **GUI 取消**：输入行已清除，远端不会误启动裸 `rz/sz`，后续 Shell 正常。
5. **异常/取消/断线**：不泄漏二进制帧到终端历史；需要重连时阻止复用旧 PTY。
6. **旧版回退**：不可识别命令、sidecar 丢失、会话忙等均不拦截，旧版 `rz/sz` 仍可运行。
7. **隔离性**：双终端交替执行命令、连续传输、重连后的旧代际输入均不串扰。
8. **特殊 Shell**：zsh、fish、tmux、JumpServer、MySQL 等不在自动切换验收范围。不能假设所有 Shell 都支持 Ctrl-U。

自动化包括：`go test -race ./internal/ssh`、`go test -race ./...`、`cd frontend; npm test -- --run`、Windows smoke。**CI 不等于 Windows GUI 实机确认**；实机未通过前不要将 `OPENSHELL_NATIVE_ZMODEM_AUTO` 默认打开，不要删除旧 ZMODEM 辅助文件。
