# 原生 ZMODEM：直接输入 rz/sz 的实验性自动接管

> **Windows 默认原生优先，保留兼容模式。** 仅在明确输入简单 Bash 命令后弹出需要授权的原生传输 GUI；不凭借远端 ZMODEM 帧头自动启动，旧引擎继续保留。

## 传输策略与启动

Windows 没有保存设置时默认 **原生优先**。在 OpenShell **设置 → 终端 → ZMODEM 传输引擎** 中随时切换：

- **原生优先（推荐）**：简单 `rz`、`sz /绝对路径` 经过原生 GUI 确认后传输，其他命令、缺少 sidecar、终端忙碌时在协议启动前沿用旧实现。
- **兼容模式（旧版）**：全部继续用现有 `trzsz-go/lrzsz` 处理器。

本地保存、立即生效，无须环境变量或重启。Windows 安装包/ZIP 必须包含 `OpenShell.exe` 同级 `zmodem/native/zmodem-sidecar.exe`。开发环境可设置 `OPENSHELL_NATIVE_ZMODEM_SIDECAR` 覆盖原生可执行文件路径。

非 Windows 平台默认兼容模式；自行切换到原生模式前须确认 sidecar 可执行、SSH 与原生文件选择器工作正常。

## 支持的自动命令

在**普通 Bash/readline Shell 提示符**且 sidecar、会话代际及终端独占检查通过的情况下：

| 用户输入 | 原生执行结果 |
| --- | --- |
| `rz`、`rz -q` | 清除尚未执行的 Shell 命令，弹出原生上传 GUI，支持一次选择最多 100 个文件 |
| `sz file.bin` | 预填远端相对路径（以当前 Shell 目录为基准），弹出下载 GUI |
| `sz -- "/tmp/文件 一.bin" /tmp/other.bin` | 解析安全的字面量引号，预填两条远端路径，单会话下载两个文件 |
| `sz -q -- file1.bin file2.bin` | 预填两个文件，仍需选择本地目录和明确确认 |
| 其他命令 | 继续原样发送到 Shell，由现有传统路径处理 |

自动接管**仅支持无编辑、未执行的字面量命令**。拒绝自动解释 Shell 变量、反引号、通配符、管道、重定向、复合命令、其他选项，以及命令历史、行编辑、多行粘贴。不匹配时保留传统处理方式；JumpServer、MySQL/Python/Redis 交互程序、正在传输的会话也不自动接管。

上传本地目录不直接按 ZMODEM 递归传输；目录同步、续传请使用 SFTP。原生文件列表最多 100 个，单文件上限低于 2 GiB，同名文件保护依旧生效。

## 实现与安全边界

1. Go `Manager.Write` 在每个精确 `ConnectionRef` 上保留一份有界输入探测状态，不缓存或记录实际命令内容。只有首次输入前 `terminalShellReadiness.checkReady()` 确认普通 Shell 提示符才可能进入探测。
2. 探测只跟踪尚未按回车、未经过编辑的 UTF-8 字面量命令，最长 4096 字节。所有其他输入均保持原样写往旧 `trzsz-go` 过滤器，避免影响正常终端。
3. 匹配命令时再次校验原生 sidecar、JumpServer 限制、当前代际及终端是否被 AI/旧传输占用。校验失败保留原始 Enter，交给旧处理器。
4. 校验通过后把最后的 Enter 替换为 Ctrl-U：**不让远端立即运行未加结束标记的命令**，只向 GUI 派发明确授权的方向/远端路径。用户取消弹窗不会启动传输。
5. 用户在 GUI 中再次确认后，仍由现有 `nativeTerminalCoordinator` 在**同一 SSH PTY** 上生成自己的受保护 Shell 命令，并等待远端随机结束标记后恢复；失败时按现有设计要求重连。
6. UI 事件绑定到原始 `ConnectionRef`，后端在真正开始前再次校验，不能让旧会话的事件触发新连接传输。

**局限**：此实现依赖远端 Bash/readline 的 Ctrl-U 行清除行为和保守的 Shell 提示符识别。极端 Shell 配置或伪装提示符可能使行编辑行为不符合预期，所以必须先在隔离测试机验收。此 PR 不是任意终端输出 `**\x18B0...` 都能触发的无条件自动接管。

## 验收流程

1. 在设置里切换 **兼容模式**，确认直接输入 `rz` / `sz /tmp/example.bin` 由旧版处理。
2. 切换 **原生优先**，不重启直接输入 `rz` 和 `sz /tmp/example.bin`，确认原生 GUI 弹出、等待选择文件与确认，且 SHA-256 相同。
3. **GUI 取消**：输入行清除且远端不执行裸命令；Shell 正常可继续使用。
4. **异常与断线**：不泄漏 ZMODEM 二进制到终端；需重连的连接不可复用。
5. **旧版回退**：不可识别命令、缺少 sidecar、JumpServer 或忙碌会话不被原生拦截。
6. **隔离性**：同一标签连续传输、两个 SSH 标签并行传输、重连代际隔离。
7. **非标准 Shell**：zsh、fish、tmux、交互程序默认走旧模式，无通用支持保证。

自动化包括：`go test -race ./internal/ssh`、`go test -race ./...`、`cd frontend; npm test -- --run`、Windows smoke。**CI 不等于 Windows GUI 实机确认**；发现问题可立即在设置中切回兼容模式，不要删除旧 ZMODEM 辅助文件。
