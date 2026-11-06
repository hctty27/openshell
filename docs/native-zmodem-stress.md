# 原生 ZMODEM：Windows → Docker Linux 压力与性能验收

> 仅用于 **Windows 本机 Go + Rust sidecar → localhost Docker Linux OpenSSH PTY + lrzsz**。默认不执行，绝不连接生产 SSH。正式客户端 `rz/sz`、`trzsz-go`、MSYS2 和 Wails UI 均不修改。

## 运行前提

- Windows PowerShell 5.1+、Docker Desktop（Linux 容器）、Go 和 Cargo。
- 首次需要构建 Docker 镜像并下载 Go/Rust 依赖；后续可复用构建缓存。
- 测试容器只将 SSH 发布到 `127.0.0.1` 的随机端口。每次运行重新生成 SSH 私钥和主机公钥，并由测试程序固定校验主机密钥；结束后清理容器和凭据。
- 测试自动生成文件，**不要修改为生产服务器地址或使用生产凭据**。
- 大文件需要磁盘空间：本地与容器内会分别存放多个 128 MiB 临时文件（建议至少预留约 2 GiB 可用空间）。

## 一条命令运行

在仓库根目录打开 PowerShell：

```powershell
.\scripts\test-native-zmodem-stress.ps1 -Profile all
```

首次推荐先跑较短的冒烟和重复测试：

```powershell
.\scripts\test-native-zmodem-stress.ps1 -Profile repeat -Rounds 5
```

可选配置：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `-Profile` | `all` | `large` / `repeat` / `parallel` / `latency` / `all` |
| `-LargeMiB` | `128` | 大文件大小，1–128 MiB（Rust sidecar 上限） |
| `-Rounds` | `30` | 连续多轮，每轮上传、下载各一次 |
| `-Workers` | `3` | 并发连接与终端数量，1–4 |
| `-LatencyMS` | `3` | 弱链路每次 TCP 读写延迟，1–10 ms |
| `-SkipBaseline` | `false` | 跳过现有 8 次互操作 SHA-256 冒烟（不建议首次跳过） |
| `-ReportDir` | `tmp/native-zmodem-stress` | JSON 测试记录目录 |

### 测试覆盖

- **large**：默认 128 MiB 双向原生传输、SFTP 参照，SHA-256 校验。
- **repeat**：默认同一终端连续 30 轮、每轮 1 MiB 上传及下载，验证任务回收及 PTY 恢复。
- **parallel**：默认 3 个独立 SSH 连接和终端同时双向传输，每个文件 4 MiB。
- **latency**：对 1 MiB 文件的客户端 TCP 读/写设置 16 KiB 分块和指定延迟，分别测原生与 SFTP，SHA-256 校验。该模式 **不模拟真实丢包**。

这些测试实际使用当前交互式 SSH PTY 和原生 Rust sidecar，**不是简单模拟协议响应**；验证后会清理文件。若一轮失败，结果应视为验收不通过，不能因为其他轮成功而忽略失败。

## Windows 本机 Go Vet 与协议测试隔离

Windows PowerShell 5.1 上的测试日志曾出现 `vet.exe: expected 'package', found '%'`，涉及多个第三方模块，尽管真实跨系统 PTY 的 8 次传输及 SHA-256 验证全部通过。该报错不等同于协议失败，也不能直接排除本机模块缓存被修改。

脚本在启动测试环境前先执行 `go mod verify`，对已经下载的依赖源码做完整性检查；失败时中止，**不自动清理或覆盖模块缓存**。通过后，专用 Go PTY 集成测试使用 `go test -vet=off`，避免本机 Vet 的独立异常误判协议验收。Go 静态分析并没有全局关闭：正式 CI 继续独立运行 `go vet ./...` 和 `go test -race ./...`。

如本机希望恢复 Vet，请先运行：

```powershell
go version
go env GOMODCACHE GOCACHE GOFLAGS
go mod verify
go vet ./internal/ssh
```

只有确认确有模块缓存损坏时，才考虑 `go clean -modcache` 与 `go mod download` 重新下载依赖；该操作会清除**所有** Go 项目共享的模块缓存，而不只是 OpenShell。

## 失败日志定位（Windows PowerShell 5.1）

如果基础联调第 4 步或压力阶段退出非零状态，脚本会保留单独的原生 Go 测试输出：

```text
tmp/native-zmodem-stress/logs/<run-id>/cross-os-pty.log
tmp/native-zmodem-stress/logs/<run-id>/interruptions.log
tmp/native-zmodem-stress/logs/<run-id>/stress-<profile>.log
```

这些日志独立于 `Start-Transcript`，包含原始 `go test -v` 的 stdout/stderr 和 `--- FAIL:` 行。发生失败时直接查看脚本报出的路径；无须根据 Docker 容器退出码猜测协议故障。临时 SSH 容器与密钥仍会清理，但本地诊断日志会保留在已被 Git 忽略的 `tmp/` 下。

## 结果与判读

在 `tmp/native-zmodem-stress/` 生成一次运行对应的 `.json` 报告：

- `profile`：运行场景。
- `attempt`：本次轮次（或并发工作线程编号，从 0 开始）。
- `protocol`：`native` 或 `sftp`，SFTP 仅作参考基线。
- `direction`：`upload` / `download`。
- `sizeBytes`：文件字节数。
- `durationMs`：本次传输时长，**不包含后续 SHA-256 校验**；原生计时包含远端结束标记确认。
- `miBPerSecond`：据传输耗时计算的 MiB/s，非瞬时网络带宽。
- `checksumOK`：本地与远端文件 SHA-256 是否一致。
- `error`：失败原因（如有）。

失败时仍尝试写出已完成轮次的 JSON；Go 测试失败和 JSON 不完整都不应被解释为通过。

**比较限制**：SFTP 参考值在相同宿主网络和文件大小下测得，但传输协议、SSH 会话特性及 CPU 开销不同。不把它等同于已有正式 `trzsz-go`/`rz/sz` 的吞吐量；旧链路的对照需要另做相同硬件与文件大小的手动基准。

## 故障边界与后续验收

- Rust sidecar 单次会话内部有 90 秒限制；128 MiB 测试如超时，会报告真实失败，不自动延长协议超时或伪报通过。
- 原生传输若因取消、超时、断线而失败，当前 PTY 会保持 fail-closed，重新连接后才可继续。
- 真实公网丢包、抖动、限速和拥塞不属于此套 TCP 延迟/分块测试。后续可在独立 Linux 测试网络使用 `tc netem` 的 `delay`、`loss` 和 `rate`，但应隔离网络命名空间，并避免直接修改生产网络接口。
- 开始自动接管终端输入的 `rz/sz` 之前，还需真实 GUI 上传/下载、长时间并发、不同 Shell、权限与第三方许可证复核。

测试代码：`internal/ssh/native_zmodem_stress_test.go`。
