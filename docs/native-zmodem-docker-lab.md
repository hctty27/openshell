# Windows 原生 ZMODEM ↔ Docker Linux 一键联调

该测试环境用于替代需要专用 VPS 和 GitHub SSH Secrets 的手动跨系统测试，**不会修改 OpenShell 正式 rz/sz / trzsz-go / MSYS2 路径**。

## 前置条件

- Windows 10/11，已启动 Docker Desktop，并切换到 **Linux containers**。
- 本机可运行 `docker`、`go`、`cargo`。Go 版本按项目 `go.mod` 安装；Rust 必须提供 Windows 原生 MSVC 工具链。
- 需要首次联网下载 `ubuntu:24.04`、Ubuntu `openssh-server` / `lrzsz` 包，以及 Go / Cargo 依赖。后续 Docker 构建可复用本地镜像缓存。
- **不需要** VPS、GitHub Secrets、修改 Windows `known_hosts` 或手动填写 `authorized_keys`。

## 一键运行

在 Windows PowerShell（不要用 WSL）进入 OpenShell 仓库根目录：

```powershell
.\scripts\test-native-zmodem.ps1
```

可选：跳过耗时的取消/超时/断线测试，仅测试正常传输：

```powershell
.\scripts\test-native-zmodem.ps1 -SkipFaultTests
```

可选：调整模拟延迟（0–10 毫秒；默认 2 毫秒）：

```powershell
.\scripts\test-native-zmodem.ps1 -LatencyMS 4
```

## 测试流程

1. Windows 原生构建并测试 Rust `zmodem-sidecar.exe`。
2. 本机构建 Ubuntu 24.04 容器，安装 OpenSSH、SFTP、`lrzsz`。
3. 容器**每次启动**重新生成一次性测试用户 SSH 密钥和独立 sshd ED25519 主机密钥，并只允许 `zmodemlab` 通过公钥登录。无需保存到 Windows `known_hosts`；Go SSH 测试使用本次从容器取出的主机公钥执行**精确匹配校验**。
4. SSH 端口仅绑定到本机 `127.0.0.1` 的动态端口，不对局域网/公网开放。
5. 原生 Windows Go+Rust 通过实际 Linux OpenSSH 交互式 PTY，传输空文件、64 KiB 二进制、中文文件名、约 4 MiB 文件，各上传、下载一次，SFTP 比较八次 SHA-256。
6. 默认额外执行 32 MiB 下载中**取消、超时、SSH 断线**三种故障注入，检查传输任务清理、终端隔离、避免发布不完整文件。
7. 无论成功或失败，PowerShell `finally` 都会尝试删除测试容器和 Windows 临时密钥文件，并恢复原有测试环境变量；Docker 镜像缓存可保留供下次构建加速。

## 代码与验证边界

- 脚本：`scripts/test-native-zmodem.ps1`
- 镜像：`experiments/native-zmodem/docker-ssh-lab/`
- 既有测试：`TestNativeZmodemCrossOSInteractivePTY`、`TestNativeZmodemLiveInterruptedInteractivePTY`。
- CI：`.github/workflows/native-zmodem-docker-lab.yml` 在 Linux Runner 验证容器镜像实际可启动、使用一次性密钥通过严格主机公钥校验建立 SSH 会话、登录后能找到 `rz/sz`，并验证 SFTP 子系统；Windows Runner 仅解析本地 PowerShell 脚本语法。

**限制**：GitHub 托管的 Windows Runner 默认并非可以稳定运行 Docker Desktop Linux 容器的 Windows 桌面，因此 CI 的 Linux fixture 通过不等于 Windows 一键脚本已经实机运行。真正的 Windows→Linux 联调必须在 Windows 上执行上述一键脚本且显示全部成功。容器回环测试亦不代表公网丢包、真实宽带限速或多发行版兼容性；这些后续分别验证。

如果 Docker Desktop 未启动或当前是 Windows containers 模式，脚本会先报错并停止；如果容器异常，可以通过脚本的自动打印日志排查。若脚本被强制终止导致容器残留，手动执行 `docker ps --filter "name=openshell-zmodem-lab-"` 查找，再按容器名执行 `docker rm -f <容器名>`。
