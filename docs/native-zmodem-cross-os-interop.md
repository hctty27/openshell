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
