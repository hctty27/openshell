# OpenShell 原生 ZMODEM 交互式终端实验入口

> 该功能是**开发者手动开启**的试验功能，不替换现有 `rz/sz`、`trzsz-go` 或 MSYS2，不自动识别/拦截终端流量。初次使用请连接隔离 Linux 测试机或 Docker SSH Lab，勿先用于生产会话。

## 启用

在 Windows PowerShell 启动 OpenShell 前设置：

```powershell
$env:OPENSHELL_NATIVE_ZMODEM_EXPERIMENT = "1"
```

正式打包版本的默认 sidecar 路径是 `OpenShell.exe` 同级 `zmodem/native/zmodem-sidecar.exe`。新增构建流程会将其一同放入 Windows 安装包和 ZIP 便携包；**未发布新版本之前，已有安装包里不一定存在该文件**。

开发构建可额外指定绝对路径：

```powershell
cd experiments/native-zmodem
cargo build --release --bin zmodem-sidecar
cd ../..
$env:OPENSHELL_NATIVE_ZMODEM_SIDECAR = (Resolve-Path "experiments/native-zmodem/target/release/zmodem-sidecar.exe").Path
```

之后正常启动开发版 OpenShell。仅当环境变量明确为 `1` 时，已连接 SSH 终端工具栏才会出现“**原生 ZMODEM · 实验模式**”按钮；未启用时不渲染入口。

## 操作

1. 在隔离 Linux OpenSSH/SFTP 服务器安装 `lrzsz`，打开普通交互式 SSH Shell，确认当前 Shell 空闲，没有 `vim`、`top` 等前台程序，未连接 JumpServer。
2. 点击终端工具栏的实验按钮，选择上传或下载。上传使用远程 Shell 当前工作目录，下载需填写远程文件绝对路径，且仅支持**单文件**。
3. 使用系统原生文件/目录选择器选择本地源或目标，阅读“失败后必须重连”提示并勾选确认，再点击开始。
4. 传输期间原生协调器独占真实 SSH PTY 的输入和输出，不应在同一终端执行其他命令、AI 操作或传统 rz/sz。
5. 正常完成后会恢复终端数据流；主动取消、超时、进程错误或 SSH 中断时会锁定不安全终端并提示**重新连接 SSH**。失败不会把未完成的下载直接保存到目标目录。

## 目前未实现

- 传输百分比、速率和 ETA（界面只展示进行中 / 取消中 / 完成 / 错误）。
- 批量文件传输、目录传输、断点续传、覆盖已有文件。
- 自动检测/切换、JumpServer 支持、传输中自动恢复或无损降级回传统协议。
- 正式发布前的安装版/便携包 sidecar 在 Windows 实机上的 GUI 联动验收及第三方依赖许可证复核。
- 128 MiB 大文件、真实公网高丢包、持续多轮长测、边缘 Shell 兼容性。

## 开发和回归

- 核心协调：`internal/ssh/native_zmodem_terminal_lifecycle.go` + `native_zmodem_terminal_coordinator.go`。
- Wails 方法：`app_native_zmodem_terminal.go`；只有显式 opt-in 才会放行执行与取消。
- React 入口：`frontend/src/components/NativeZmodemExperimentDialog.tsx`。
- CI：Go Race、前端单测、Windows sidecar/Rust、真实 Linux SSH PTY、Windows EXE 冒烟。
- Windows→Linux 实际协议回归脚本：`scripts/test-native-zmodem.ps1`（需本机 Docker Desktop Linux containers）。

**安全边界**：`NativeZmodemInteractiveReadiness` 不执行命令；后端每次提交均再次验证实验开关、当前连接代际、sidecar 文件、JumpServer 和 PTY 占用。sidecar 独立进程只收发二进制 ZMODEM 数据；不会向传统终端输出协议帧。
