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
| `-LatencyMS` | `3` | TCP 读写附加延迟，0–10 ms；0 表示无额外延迟 |
| `-SkipBaseline` | `false` | 跳过现有 8 次互操作 SHA-256 冒烟（不建议首次跳过） |
| `-ReportDir` | `tmp/native-zmodem-stress` | JSON 测试记录目录 |

### 测试覆盖

- **large**：默认 128 MiB 双向原生传输、SFTP 参照，SHA-256 校验。
- **repeat**：默认同一终端连续 30 轮、每轮 1 MiB 上传及下载，验证任务回收及 PTY 恢复。
- **parallel**：默认 3 个独立 SSH 连接和终端同时双向传输，每个文件 4 MiB。
- **latency**：对 1 MiB 文件的客户端 TCP 读/写设置 16 KiB 分块和指定延迟，分别测原生与 SFTP，SHA-256 校验。该模式 **不模拟真实丢包**。

这些测试实际使用当前交互式 SSH PTY 和原生 Rust sidecar，**不是简单模拟协议响应**；验证后会清理文件。若一轮失败，结果应视为验收不通过，不能因为其他轮成功而忽略失败。

## 原生写入合并 A/B 实验（默认关闭）

Rust sidecar 增加 **仅实验模式使用** 的有界 `Action::WriteWire` 缓冲。默认 `0 KiB`，与先前逐帧 `write_all + flush` 完全一致；可在独立压力测试中设置为 `4`、`8`、`16` 或 `32 KiB`。

连续小帧只做字节级拼接，帧内容和顺序不改。缓冲达到上限、遇到大帧、进入 `Action::Idle`（等待远端输入）或收到文件/会话完成事件时立即强制 `flush`。所有模式都保留握手完成及终端失败后必须重连的安全策略。

```powershell
# 不加速的原始行为，对照组
.\scripts\test-native-zmodem-stress.ps1 -Profile latency -WireBatchKiB 0

# 实验组：最多缓存 16 KiB
.\scripts\test-native-zmodem-stress.ps1 -Profile latency -WireBatchKiB 16

# 通过弱链路对照后，再执行完整回归
.\scripts\test-native-zmodem-stress.ps1 -Profile all -WireBatchKiB 16
```

`-WireBatchKiB` 由测试脚本临时注入 `OPENSHELL_ZMODEM_WIRE_BATCH_BYTES`，结束或异常退出后会恢复原环境变量。无需改动 OpenShell 正式设置、用户终端、SSH 配置或安装包默认行为。

可分别选择 `-LatencyMS 0`、`-LatencyMS 1`、`-LatencyMS 3`、`-LatencyMS 5` 做相同配置的比较。

报告 `options.wireBatchBytes` 会记录本次使用的缓冲大小（0 表示原始模式）。A/B 测试必须对照 JSON `io.toRemoteCalls`、`io.toRemoteWriteNs`、`miBPerSecond`、SHA-256；推荐每个延迟条件至少重复 5 次，并交替执行两组，以减少环境波动。**减少写入次数不代表一定能提高速度**：当 ZMODEM 协议当前流程必须等待远端 ACK 时，将始终在等待前 flush，不跨协议反馈边界强行拼接。缓冲不会改变模拟器的 3ms TCP 读写延迟语义；它也不模拟真实丢包。

## 自动 A/B 矩阵测试

矩阵测试专用入口会在**同一个临时 Docker Linux SSH 测试环境**中交替运行 0、4、8、16、32 KiB 的原生传输缓冲。默认测试 TCP 额外延迟 0、1、3、5 ms，每个组合重复 5 次，分别验证原生与 SFTP 上传、下载的 SHA-256，并记录完整样本。不修改默认传输配置。

```powershell
# 首次建议先用短矩阵验证环境和脚本
.\scripts\test-native-zmodem-batch-matrix.ps1 -Rounds 1

# 完整矩阵，4 个延迟 × 5 种缓冲 × 5 轮
.\scripts\test-native-zmodem-batch-matrix.ps1 -Rounds 5
```

矩阵依次运行各延迟条件，并按奇偶轮改变缓冲大小的测试顺序，避免始终由同一方案占据第一或最后一次样本。默认共 100 个组合样本，**每个样本有 4 条传输记录**（原生上传/下载、SFTP 上传/下载），共 400 次有 SHA-256 校验的文件传输。

JSON 文件写入 `tmp/native-zmodem-stress/native-zmodem-matrix-*.json`，包含：

- `cases[]`：每次样本的 `latencyMs`、`wireBatchKiB`、`round` 和四条原始传输记录。
- `summaries[]`：按延迟、缓冲、协议和方向聚合，记录 `count`、`medianMiBPerSecond`、`p95DurationMs`、`allChecksumsOK`。
- `p95DurationMs` 采用 nearest-rank 方法；样本不足时 P95 与最大值接近，因此正式决策应结合中位数、极端值和多轮复测。

失败会保留已经完成的报告，整轮仍判为失败；绝不通过丢弃异常轮次得到“通过”结论。

**注意**：同一延迟下连续使用一个 SSH 连接减少了环境切换，但仍可能存在系统缓存、CPU 调度和 Docker 资源波动。实际 `0/1/3/5 ms` 是 TCP 读写附加延迟，不代表真实公网延迟或丢包率。选择默认值之前，还应检查 128 MiB 大文件多次重复、取消/断线以及实际 GUI。

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

## 分阶段耗时和 Go 诊断

原生传输现在在 JSON 每条原生记录中额外输出 `stagesMs`（毫秒），并在 PowerShell 按场景、方向汇总：

| 字段 | 定义 |
|---|---|
| `prepare` | 校验本地路径、创建独立 pipe、取得终端独占权，直到远程 Shell 启动命令写入完成 |
| `protocol` | 远端命令发出后，直到本地 Rust sidecar 退出；**包括**远端启动握手、文件传输、SSH PTY 转发与协议交互 |
| `remoteConfirm` | 本地 sidecar 完成后等待远端 Shell 的结束状态标记 |
| `restorePublish` | 恢复终端路由，并在下载场景发布已验证的本地文件 |

这些是四个**串行阶段**，不是 Rust CPU 时间、SSH 写入时间或单独的磁盘 I/O 时间。若一个阶段耗时明显异常，需要结合 Go Trace 和后续 Rust 端采样进一步定位。失败阶段之后的数据可能缺失，不得视为零耗时。

使用下列命令在同一隔离测试环境中收集 Go CPU Profile 与运行时 Trace：

```powershell
.\scripts\test-native-zmodem-stress.ps1 -Profile latency -Diagnostics
```

诊断文件会与完整测试日志一起存放在 `tmp/native-zmodem-stress/logs/<run-id>/`，例如 `stress-latency.cpu.pprof`、`stress-latency.trace`。可使用 `go tool pprof -top <cpu.pprof>` 查看热点、`go tool trace <trace-file>` 查看 `native-zmodem:upload/download` 区间。

`-Diagnostics` **默认关闭**，因为 CPU 和 Trace 采样本身可能影响耗时；做严格的前后吞吐量比较时应保持关闭。Go 的 Profile 只覆盖 Go 测试进程，不覆盖独立 Rust sidecar 的 CPU 占比。

## Go→Rust→SSH 写入与等待诊断

仅在显式开启 Windows 原生压力测试时，每条原生传输记录会增加 `io` 对象（SFTP 参照记录不会有该字段）：

| JSON 字段 | 单位 | 含义 |
|---|---|---|
| `toRemoteCalls` | 次 | Rust sidecar 经 Go 终端独占写入器发往 SSH PTY 的实际写入次数 |
| `toRemoteBytes` | 字节 | 以上写入器成功写出的原生协议字节（包含控制帧和必要的转义；不是文件净荷大小） |
| `toRemoteWriteNs` | 纳秒 | 写入 SSH PTY 的调用墙钟时间总和，包含 Go/SSH 写入阻塞 |
| `readyWaitNs` | 纳秒 | 每次待远端 ZMODEM 握手就绪的选择等待累计值；就绪后的立即选择也会有极小开销 |
| `fromRemoteCalls` | 次 | SSH PTY 输出转发进入 Rust sidecar 专用管道的写入次数 |
| `fromRemoteBytes` | 字节 | 通过专用管道转发的数据量（协议字节数，非文件净荷） |
| `toSidecarPipeNs` | 纳秒 | 写入 Rust sidecar stdin 专用 `io.Pipe` 时的累计阻塞/消费耗时 |

这些字段是**聚合调用耗时**，不能直接相加推算总传输时间；多个方向可以重叠，`io.Pipe.Write` 的时间也包含等待对端读取。运行时是否形成网络小包、远端窗口大小和 Rust 内部的 `poll` 开销，仍需下一轮独立验证。

本次不会修改 Rust sidecar 的协议帧格式或默认缓冲策略，避免在完成瓶颈定位之前改变对照基线。测试命令：

```powershell
.\scripts\test-native-zmodem-stress.ps1 -Profile latency -Diagnostics
```

报告仍在 `tmp/native-zmodem-stress/`；`-Diagnostics` 会另外保存 Go Profile/Trace，仅用于排查，不适合作为无扰动吞吐量基准。

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
