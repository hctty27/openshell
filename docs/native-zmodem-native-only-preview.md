# Windows 原生 ZMODEM 独立预览包

此预览包用于在 Windows 桌面上完成**无本地 `lrzsz-win32`、无 `msys-2.0.dll`** 的 ZMODEM 实机验收，并非正式稳定版。

## 下载位置

在 PR 的 **Windows terminal smoke** GitHub Actions 成功完成后，进入 Artifacts 下载：

- `OpenShell-windows-x64-native-only-preview` —— 此文档所述纯原生包。
- `OpenShell-windows-x64-smoke` —— 同一构建的旧版组件兼容对照包。

预览 ZIP 文件结构：

```text
OpenShell.exe
zmodem/
  rz.exe
  sz.exe
  native/
    zmodem-sidecar.exe
```

两个顶层 `rz.exe/sz.exe` **不是**旧的 `lrzsz-win32`，是 OpenShell 自己的 Windows GUI-subsystem 启动器，原样转发标准输入/输出/错误、继承工作目录，且在没有旧组件时向 Rust sidecar 提交 `compat-rz/compat-sz` 动作。唯一的本地 ZMODEM 协议实现是 Rust。

## 验收矩阵

1. 打开 PowerShell，确保没有旧 OpenShell 进程；解压并在新的文件夹运行 `OpenShell.exe`。目录内不存在 `msys-2.0.dll`、`lrzsz-win32-source.zip`、`native/rz.exe`、`native/sz.exe`。
2. 在普通 Bash 提示符下执行 `rz`，使用原生 GUI 上传多个文件（含中文、空格和空文件）并核对 Linux SHA-256。
3. 执行 `sz -q -- "/tmp/hello world.bin" /tmp/other.bin`，下载多个文件并核对 Windows SHA-256。
4. 打开 **设置 → 终端 → ZMODEM 传输引擎** 切换成兼容模式。直接从 Linux 输入 `rz`、`sz`，确认旧协议探测器仍能启动本地 **Rust** `rz.exe/sz.exe` 包装程序，文件完整性不受影响。
5. 在 Linux 服务器通过远端脚本主动执行 `sz`，确认无需在 OpenShell 键入命令、依靠旧过滤器的远端启动帧检测仍能落到 Rust 本地引擎。
6. 再分别确认 `trz`、`tsz`，验证独立协议没有因替换本地 ZMODEM 程序被删除。
7. 验证 `-E` 重名下载自动生成新文件，不覆盖已有文件；非自动重命名的原生 GUI 上传/下载仍执行原有不覆盖策略。
8. 多会话、分屏、连续传输、主动取消、断线、超时、弱网、单文件 1 GiB，检查终端历史没有二进制帧，错误恢复需要重新连接时仍禁止继续复用旧 PTY。

## CI 已覆盖与尚需实测的边界

Windows smoke 应自动检查**完整打包无旧 DLL**、两个 GUI-subsystem 启动器的 `--version` 路由，以及用与固定版本 trzsz-go 相同的参数执行两个真实本地 Rust 进程端到端管道传输，全部 SHA-256 校验。协议互操作和 Go Race 还会作为普通 PR CI 运行。

**CI 不代表 Windows Wails 实机**，也未自动验证通过真正 SSH PTY 的远端自动发起握手、网络断连后的终端恢复或 GB 级真机长测。因此未完成以上验收前，不应将正式安装版/便携版改成纯原生发布。

如果预览包内的 Rust 兼容模式有问题，暂时使用同一 Actions 中的 `OpenShell-windows-x64-smoke` 对照包，或者在 OpenShell 设置里切回“原生优先”走已经验证的命令授权入口。不要把部分传输成功误判为完整批次成功。
