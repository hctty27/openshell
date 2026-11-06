# 原生 ZMODEM 批量传输验收（Windows GUI + Linux SSH）

## 已完成的功能实现

- 单次传输 1–100 个普通文件，保持每文件大小低于 2 GiB；整个批次在一个 SSH PTY 独占期、一个远端 `rz/sz` 进程和一个本地 Rust sidecar 进程内完成。
- Windows 原生选择多个上传文件；也可以在输入框逐行填写绝对本地文件路径。
- 下载支持逐行填写远端文件路径，或者终端执行 `sz -q -- "name with spaces.bin" second.bin`，由客户端解析无 Shell 扩展的字面量路径后打开 GUI。下载发布只发生在远端完成确认之后。
- 大小写不敏感的上传文件名冲突检查；接收端禁止文件覆盖、符号链接和路径穿越；批量下载到临时目录，全部成功再发布，失败尝试回滚。
- 不支持原生递归目录和中途续传。带变量/通配符、行内编辑、管道/复合命令暂时仍走旧版兼容路径。

## 常规 CI 自动化

- Rust Windows native-to-native：单文件、三文件一个会话以及 NUL 文件清单 `send-list` → `receive`，检查 SHA-256。
- Rust Linux lrzsz：`sz` → Rust 与 Rust → `rz`，各包含一次三文件协议会话，检查 SHA-256。
- Go Race：批量文件清单、路径解析与转义、覆盖保护、失败回滚、同一 PTY 独占与远端结束证明。
- Frontend：多选文件、远端文件列表、数量限制、进度隔离和取消行为。
- Windows smoke：Wails 多选文件 API 编译、GUI 资源、Rust sidecar 和打包校验。

## Windows 实机必须测试

1. 连接独立 Linux 测试主机，确认安装 `lrzsz`，在 **设置 → 终端** 选择「原生优先」。
2. 在普通 Shell 输入 `rz`，选择三个文件：英文、中文加空格，以及空文件；确认远端三个文件 SHA-256 全相同、进度结束后可立即继续使用终端。
3. 在远端准备三个文件后输入 `sz -q -- "foo bar.bin" bar.bin "中文 文件.bin"`，应打开原生窗口，显示三行远端路径、选择本地目录后逐个下载并与远端 SHA-256 一致。
4. 再测试相对路径、带反斜杠的转义文件名、引用引号，确保远端路径不发生 Shell 注入。
5. 预先在本地保存目录创建重名文件，下载批次必须整体失败，**原重名文件不能被覆盖，其他文件不能留下已发布的半批次**。
6. 正在上传/下载时主动取消、断线、关闭标签、多标签同时传输，确保失败不会把二进制帧泄漏给终端历史/AI，未确认状态要求重连。
7. 先切到「兼容模式」再测试直接输入 `rz/sz` 与 `trz/tsz`，验证旧版回退未破坏。
8. 实机选取 512 MiB/1 GiB 单文件并执行 `scripts/test-native-zmodem.ps1 -SkipBaseline -SkipFaultTests -StressGiB -StressGiBMiB 1024`。此命令需要 Windows Docker Desktop、Go、Rust、数 GiB 可用磁盘。记录两端 SHA-256、耗时与 Git SHA。

**通过要求**：普通 CI 全绿、上述 Windows GUI 多文件上传/下载/取消和 GB 级实测记录 PASS，才允许准备移除 Windows 旧版 ZMODEM/MSYS2 可执行文件。不能把 Linux runner 和模拟 GUI 的通过结果当作 Windows 实机通过。

## 最终 Windows 原生唯一打包的剩余阻碍

旧 `trzsz-go` 过滤器目前同时负责传统 ZMODEM 的**远端协议帧检测**和独立的 `trz/tsz` 协议支持。当前原生自动接管发生在用户明确输入字面量 `rz/sz` 命令时；复杂命令和远端主动传输仍依赖旧引擎。直接删除 `lrzsz-win32`、`msys-2.0.dll` 或直接禁用 `trzsz-go` ZMODEM 检测，会让这些场景失败。

完整替换必须先接上可信的远端启动帧接管与结束证明，或者让原生 sidecar 安全实现与旧过滤器兼容的本地启动接口，并对 Windows 实机完整回归。到那之前旧二进制保留在**兼容构建**，不能宣称安装包已完全无 MSYS2。
