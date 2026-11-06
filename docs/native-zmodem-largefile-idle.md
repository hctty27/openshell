# 原生 ZMODEM 大文件与无活动超时（P0）

本阶段把早期 128 MiB、90 秒整个会话硬截止改为可运行 GB 级的单文件传输。**不声称已经实机验证 1 GiB；该项需要手动跑独立 Windows/Docker 实验。**

## 安全兼容上限

- OpenShell Go 文件校验和 Rust sidecar 的发送、接收均统一为 **最大 2 GiB - 1 字节**。原生 ZMODEM 的现有协议库用 32 位偏移；保守停在 2 GiB 以下，以兼容旧的 32 位 lrzsz 对端。不承诺 2 GiB 及以上或超过 4 GiB 的传输。
- 继续坚持单文件、原生 UTF-8 文件名、防目录穿越、防覆盖，下载保留临时目录和完成证明后再原子发布。
- 仍不具备多文件/目录原生传输；大文件应保证本地、远程有足够剩余空间。

## 新超时模型

Go（交互式 PTY 与独立 SSH Session）与 Rust sidecar 都从固定的 90 秒**总时长**改成 90 秒**无协议活动**：

1. 建立传输时启动看门狗。任一方向成功写入非零协议字节，就刷新 Go 看门狗；Rust 内部成功交换协议帧、读取文件块或落盘时刷新它自己的看门狗。
2. 只要持续传输，允许整个传输超过 90 秒；连续 90 秒没有活动则结束。为了避免紧密轮询，Go 最多 1 秒检查一次。
3. 用户主动取消、父 Context 截止时间、SSH 断开仍然优先；传输错误后仍 fail-closed，不把残余的二进制流交回终端解析器，必要时提示重连。
4. 单纯传输进度百分比无法证明远端已完成，只有原有随机结束标记验证通过后才发布下载结果。
5. 这个模型检测的是**协议活动**而非强制的有效文件字节增长；持续重传可能保持会话存活，用户仍可手动取消。后续可考虑新增独立重试预算和无有效载荷进展超时。

## Windows 1 GiB 实测

仅在有至少数 GiB 可用存储的 Windows 开发机上，使用 Docker Desktop 的隔离 Linux OpenSSH/lrzsz fixture：

```powershell
.\scripts\test-native-zmodem.ps1 -SkipBaseline -SkipFaultTests -StressGiB -StressGiBMiB 1024
```

测试脚本会从当前 Rust 源码编译 sidecar、启动只映射到 `127.0.0.1` 的 Docker SSH Lab，逐一完成原生上传、原生下载和两端 SHA-256 校验。进度日志写在 `tmp/native-zmodem-stress/logs/...`。如果先想跑小一点，可设置 `-StressGiBMiB 256` 或 `512`。

- 该测试是**显式选择**，不会随 PR CI 自动运行；不能把 CI 的普通单元测试当作 1 GiB 实测通过。
- 记录测试提交、Windows/Go/Rust/Linux 版本、实际文件大小、每个方向 SHA-256、耗时及异常恢复。
- 成功后再覆盖 1 GiB 的高延迟、丢包、主动取消及断线，确认无残留分片/跨终端串扰。
- `test-native-zmodem.ps1` 会按已有脚本流程在 finally 中清理临时 Docker 测试容器和测试环境。

## 仍需解决

多文件/批量、复杂 Shell 命令、原生目录、断点续传（可继续通过 SFTP 实现）、Windows 安装包完全移除 MSYS2/旧 rzsz 辅助工具，以及完整实机 GUI 的取消/断线/多会话验收，均**不在本 P0 PR 范围**。兼容模式依然保留。
