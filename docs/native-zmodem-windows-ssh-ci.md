# Windows 原生 ZMODEM SSH 互操作验证

## 目的

针对 Windows `GOOS=windows` 的 OpenShell Go SSH 传输桥接和独立编译的 **Rust Windows EXE**，验证加密 SSH 会话中真实 ZMODEM 协议字节交换，而非两个 Rust sidecar 之间的 Windows 本地管道回环。

测试位于 `internal/ssh/native_zmodem_windows_e2e_test.go`，通过 `.github/workflows/native-zmodem-probe.yml` 在 `windows-latest` 运行。

## 设计边界

- 客户端是 Windows 原生 Go `RunNativeZmodemTransport` + Rust `zmodem-sidecar.exe`。
- 服务端为仓库内的 `internal/testssh` 加密 SSH 测试夹具，接受 `pty-req`，启动真实的 `lrzsz-win32` `rz.exe` / `sz.exe` 子进程。
- `lrzsz-win32` 和 `msys-2.0.dll` 由现有 `scripts/prepare_zmodem_windows.ps1` 下载并验证 SHA-256，只作为 **CI 远端互操作对端**；OpenShell 本地使用的仍是 Rust EXE。
- 此夹具只确认 SSH 协议级 PTY 请求成功，**不分配真正 Windows ConPTY**，因此不能作为“Windows↔Linux SSH PTY 已通过”的证据。Linux 的真实 PTY 测试仍由既有 Ubuntu/OpenSSH CI 执行。
- 文件范围包括空文件、1 字节、64 KiB 二进制、中文文件名与大于 1 MiB 二进制。每次分别验证 Rust→真实 `rz` 与真实 `sz`→Rust 的 SHA-256 一致。
- 与正式的交互式 SSH 终端、`trzsz-go`、前端选择器及发布包隔离。不会将 MSYS2 作为新原生方案的运行时依赖，不移除现有 MSYS2 发行组件。

## 验证门槛

- [ ] Windows GO + Rust EXE 经 SSH fixture，双向 SHA-256 验证通过
- [ ] 原 Linux 真实 PTY / `lrzsz` 互操作仍通过
- [ ] 主项目 Go Race Test、前端测试通过
- [ ] 不修改 Windows 发布流程或安装包依赖

## 后续需要单独验证

真实 Windows 原生客户端连接 Linux OpenSSH 服务器，并使用 Linux 系统 `lrzsz` 的双向传输；尤其需要大文件、延迟和丢包条件、取消、断线、文件名编码，以及真实 OpenShell 已打开终端中的流独占移交。

本 PR 不包含正式版切换或发布。
