# OpenShell 原生 ZMODEM 交互式终端实验入口

> 该功能是**开发者手动开启**的试验功能，不替换现有 `trzsz-go` 或 MSYS2。默认不接管终端直接输入的 `rz/sz`；可通过独立双开关启用受限的命令意图识别（见下文），不是纯协议帧自动接管。初次使用请连接隔离 Linux 测试机或 Docker SSH Lab，勿先用于生产会话。

## 启用与兼容模式

Windows 默认选择 **原生优先**，可在 **设置 → 终端 → ZMODEM 传输引擎** 改成 **兼容模式（旧版）**。应用内保存后立即生效，不需要设置 `OPENSHELL_NATIVE_ZMODEM_EXPERIMENT` 或 `OPENSHELL_NATIVE_ZMODEM_AUTO`。

原生 sidecar 默认路径为 `OpenShell.exe` 同级的 `zmodem/native/zmodem-sidecar.exe`。开发版如果构建目录不同，可以显式设置 `OPENSHELL_NATIVE_ZMODEM_SIDECAR`（绝对路径）。缺少 sidecar 或不满足接管条件时，输入 `rz/sz` 使用旧引擎处理。

在普通 Bash Shell 提示符下输入简单 `rz` 或 `sz /绝对路径`，也可自动弹出原生上传/下载 GUI；其余复杂命令继续走旧实现。详细规则见 [原生命令接管说明](native-zmodem-auto-command.md)。

## 操作

1. 在隔离 Linux OpenSSH/SFTP 服务器安装 `lrzsz`，打开普通交互式 SSH Shell，确认当前 Shell 空闲，没有 `vim`、`top` 等前台程序，未连接 JumpServer。
2. 点击终端工具栏的实验按钮，选择上传或下载。上传使用远程 Shell 当前工作目录，下载需填写远程文件绝对路径，且仅支持**单文件**。
3. 使用系统原生文件/目录选择器选择本地源或目标，阅读“失败后必须重连”提示并勾选确认，再点击开始。
4. 传输期间原生协调器独占真实 SSH PTY 的输入和输出，不应在同一终端执行其他命令、AI 操作或传统 rz/sz。
5. 原生协调器隔离内部命令的 PTY 回显，不改变远端终端的 echo 模式。正常完成后会恢复终端数据流；主动取消、超时、进程错误或 SSH 中断时会锁定不安全终端并提示**重新连接 SSH**。失败不会把未完成的下载直接保存到目标目录。

## 目前未实现

- 已接入实验性字节进度、百分比、处理速率与 ETA：数据来自 Rust sidecar 的文件读/写回调，不能视为远端持久化确认；界面会将运行中百分比限定在 99%，必须等待远端 `rz/sz` 结束标记和成功退出才报告完成。
- 批量文件传输、目录传输、断点续传、覆盖已有文件。
- 任意命令/复杂 Shell 的自动接管、JumpServer 支持、传输中自动恢复或无损降级回传统协议；只识别有限的 Bash 简单命令。
- 正式发布前的安装版/便携包 sidecar 在 Windows 实机上的 GUI 联动验收及第三方依赖许可证复核。
- 文件上限已从 128 MiB 提升至 2 GiB 以下，固定 90 秒总时限改为 90 秒协议无活动超时；1 GiB 跨系统传输仍须单独验证，参见 [大文件与无活动超时验收](native-zmodem-largefile-idle.md)。
- 真实公网高丢包、持续多轮 GB 级长测、边缘 Shell 兼容性仍待验证。

Windows GUI 实机验收矩阵与记录门槛参见 [native-zmodem-gui-acceptance.md](native-zmodem-gui-acceptance.md)。CI 无法代替真实 WebView2、Win32 文件选择器和交互式 SSH 的人工验收。

## 开发和回归

- 核心协调：`internal/ssh/native_zmodem_terminal_lifecycle.go` + `native_zmodem_terminal_coordinator.go`。
- Wails 方法：`app_native_zmodem_terminal.go`；由应用内传输模式决定是否允许新的原生操作，正在运行的任务即使切换模式仍可取消。
- React 入口：`frontend/src/components/NativeZmodemExperimentDialog.tsx`。
- CI：Go Race、前端单测、Windows sidecar/Rust、真实 Linux SSH PTY、Windows EXE 冒烟。
- Windows→Linux 实际协议回归脚本：`scripts/test-native-zmodem.ps1`（需本机 Docker Desktop Linux containers）。

**安全边界**：`NativeZmodemInteractiveReadiness` 不执行命令；后端每次提交均再次验证传输模式、当前连接代际、sidecar 文件、JumpServer 和 PTY 占用。sidecar 独立进程只收发二进制 ZMODEM 数据；不会向传统终端输出协议帧。
