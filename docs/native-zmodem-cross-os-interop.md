# OpenShell 原生 ZMODEM 跨 Windows/Linux 交互式 PTY 联调

## 验证范围

`TestNativeZmodemCrossOSInteractivePTY` 通过 OpenShell 的 `Manager.OpenTerminal` 创建实际 SSH 交互式 Shell，然后调用尚未进入正式 UI 的原生 ZMODEM 协调器进行单文件上传和下载。远端文件使用 **SFTP 子系统** 读写及 SHA-256 校验，测试代码不会假设客户端和服务器共享文件系统。

- 空文件、64 KiB 二进制、UTF-8 中文文件名、约 4 MiB 文件，每项上传和下载各一次。
- 双向传输均确认 SHA-256，且同一个交互式 PTY 可以继续处理下一次传输和普通用户输入。
- 可通过 `OPENSHELL_ZMODEM_CROSS_OS_LATENCY_MS=2` 对 SSH TCP 流增加可重复的延迟和 16 KiB 读写分块。这是 **TCP 延迟/分段模拟**，不等同于真实网络丢包、重传或带宽压测。
- SSH Host Key 必须使用目标服务器的正确公钥精确匹配，不能禁用校验。

## Linux CI

`native-zmodem-probe.yml` 在 Linux runner 启动真实 OpenSSH 和 SFTP 子系统，运行现有 Linux 交互式测试，再运行新跨文件系统检查。该 CI 的客户端仍是 **Linux 原生 Go + Rust**，因此不能作为 Windows 本机连接 Linux 的成功证据。

## Windows 真机手动联调（仅隔离测试服务器）

准备一台专门用于测试的 Linux OpenSSH 服务器，开启 SFTP 并安装 `lrzsz`。测试账号须可写自己的 HOME；建议使用非生产测试账号、一次性 SSH 密钥和单独测试目录，不要使用生产服务器或真实业务数据。

在 Windows PowerShell 的 OpenShell 项目根目录执行：

```powershell
cd experiments/native-zmodem
cargo build --locked --release --bin zmodem-sidecar
cd ../..

$env:OPENSHELL_ZMODEM_CROSS_OS_PTY = '1'
$env:OPENSHELL_ZMODEM_LIVE_SSH_ADDR = 'your-linux-test-server:22'
$env:OPENSHELL_ZMODEM_LIVE_SSH_USER = 'testuser'
$env:OPENSHELL_ZMODEM_LIVE_SSH_KEY = 'C:\\test-keys\\id_ed25519'
$env:OPENSHELL_ZMODEM_LIVE_SSH_HOSTKEY = 'C:\\test-keys\\ssh_host_ed25519_key.pub'
$env:OPENSHELL_ZMODEM_LIVE_SIDECAR = (Resolve-Path 'experiments/native-zmodem/target/release/zmodem-sidecar.exe').Path
$env:OPENSHELL_ZMODEM_CROSS_OS_LATENCY_MS = '2'

go test -count=1 -timeout=10m -v ./internal/ssh -run '^TestNativeZmodemCrossOSInteractivePTY$'
```

环境变量里的 Host Key 文件是**远端 Linux sshd 主机公钥**，不是用户自己的登录公钥。私钥只在本机/CI Runner 读取，不能提交仓库。成功后检查空文件、二进制、中文文件名和较大文件的双向传输及终端恢复日志。

## 尚未完成

- Windows→Linux 真机测试只有在 Windows 环境真正执行该 Go 测试且使用 Windows Rust sidecar、Linux OpenSSH 时才能标记通过；Linux/Windows 两种 GitHub 托管 Runner 是独立 VM，不会自动共享 SSH 会话。
- GitHub 不保证托管 Runner 的嵌套虚拟化稳定性，因此不会将 WSL2 当作强制 CI 前提。
- 仍需后续测试 128 MiB 上限、真实高延迟和丢包、远端主动终止、用户选择取消、长时间反复传输、Wails 前端交互与正式打包。
- 当前正式 `rz/sz`、`trzsz-go`、MSYS2 和发布包保持不变；本阶段不增加用户可见原生传输开关。

## PR #218：Windows 托管 Runner 手动联调工作流

新增 `.github/workflows/native-zmodem-windows-linux-lab.yml`。这是单独的 `workflow_dispatch`，不会随 PR、push 或正式版发布自动运行。必须**先在专用 Linux 测试服务器**准备好真实 OpenSSH、SFTP、`lrzsz` 和非 root 的一次性测试账号。服务器应有出站可访问的 SSH 端口，并单独限制访问与清理测试数据。

GitHub 仓库 **Settings → Secrets and variables → Actions** 中配置以下 **Repository secrets**：

| Secret | 含义 |
|---|---|
| `NATIVE_ZMODEM_LAB_ADDRESS` | Linux 测试机的 `hostname:port` 或 `IPv4:port`，例如 `zmodem-lab.example.net:22` |
| `NATIVE_ZMODEM_LAB_USER` | 非 root 专用 Linux SSH 测试账号，必须有可写 HOME |
| `NATIVE_ZMODEM_LAB_PRIVATE_KEY` | 与测试账号 authorized_keys 匹配的专用未加密 OpenSSH 私钥（多行原文） |
| `NATIVE_ZMODEM_LAB_HOST_PUBLIC_KEY` | **远端 sshd 服务器的真实主机公钥**，如 `ssh-ed25519 AAA...`，不能使用客户端公钥或盲目信任首次连接 |

在 Actions 页面选择 **Native ZMODEM Windows to Linux lab → Run workflow**，选择目标分支并手动启动。工作流在 `windows-latest` 上原生编译、测试 Rust `zmodem-sidecar.exe`，从 Secrets 写入 Runner 临时目录，随后运行两个真实交互式 SSH PTY 测试：

1. `TestNativeZmodemCrossOSInteractivePTY`：空文件、64 KiB、中文文件名及约 4 MiB 文件，上传+下载 8 次，SFTP SHA-256 交叉校验。
2. `TestNativeZmodemLiveInterruptedInteractivePTY`：32 MiB 文件下载过程中取消、超时及关闭 SSH 连接，验证文件不被错误发布、原生任务退出及其他 SSH 通道隔离。

失败后 GitHub Actions 的 `always()` 清理步骤删除本地临时密钥目录；测试代码负责远端临时文件清理。工作流不上传密钥或客户端文件到 Artifact；不要在日志中输出测试凭据。

**注意**：该工作流在没有配置 Secrets 时会安全失败；不存在可直接借用的生产 SSH 测试服务器。只有上述 `windows-latest` 实际连通专用 Linux 主机且测试通过，才可声称 Windows 原生 Go + Rust → Linux OpenSSH 真实交互式 PTY 已验证。GitHub 的独立 Linux Runner CI 和 Windows 侧 `lrzsz-win32` 测试不能替代它。

## 正式客户端实验入口的安全边界

`Manager.NativeZmodemExperimentalReadiness(ref, sidecarPath, optedIn)` 提供只读就绪检查。`optedIn=false` 必须始终返回 disabled；函数还校验 sidecar 绝对路径、普通文件/非符号链接、当前 ConnectionRef 代际、JumpServer 限制、AI/传输占用、失败锁定后的重连要求。它**不启用**正式传输，不启动子进程，不添加 Wails UI、设置开关或文件选择器。

待 Windows→Linux 真机测试通过后，再单独设计需要用户明确同意的客户端实验入口、sidecar 分发与校验，以及出现失败时的回退/重连交互。当前所有用户继续走正式 `rz/sz`、`trzsz-go` 和 MSYS2 链路。
