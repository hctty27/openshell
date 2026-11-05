# Windows native ZMODEM feasibility spike / Windows 原生 ZMODEM 技术验证

> **Non-production experiment.** This directory is not referenced by the OpenShell Windows release workflow and does not replace `rz/sz`, `msys-2.0.dll`, or any existing transfer path.

## Baseline in OpenShell

Existing SSH path (`internal/ssh/terminal.go`):

1. Opens an SSH PTY, wires `userInput` and `remoteInput` to a `trzsz.TrzszFilter`.
2. Enables traditional ZMODEM with `TrzszOptions{EnableZmodem: true}`.
3. `zmodemDirectionWriter` identifies transfer direction from the remote header.
4. `selectZmodemPaths` provides the local picker, cancellation and upload/download paths through the filter.
5. The existing `trzsz-go` ZMODEM path invokes local `rz/sz` binaries. The Windows release bundles first-party GUI wrappers and third-party `lrzsz-win32` plus `msys-2.0.dll`.

**Implication:** changing the `rz.exe/sz.exe` files or adding a Go backend enum alone is **not sufficient** to replace the implementation. The `trzsz-go` filter owns the protocol transfer lifecycle. Replacing it requires a filter extension/hook or carefully isolated interception of binary PTY streams.

## Candidates evaluated

| Candidate | License / code | Current conclusion |
| --- | --- | --- |
| Keep `lrzsz-win32` | GPL-2.0 + unresolved MSYS2 historical source match | Compatible shipping fallback; no removal in this PR |
| `kookob/rzsz` | Apache-2.0 Rust | Currently relies on `std::os::unix::io`, `nix::termios` and `poll` in terminal/reader, so **not** an immediate Windows replacement |
| `zmodem2` | Rust protocol library, dual Apache-2.0/MIT licensing to verify by crate package | Caller-driven `Sender`/`Receiver` state machines that own **no OS I/O**; promising for Windows but not a ready `rz/sz` CLI |
| Native Go implementation | No mature, independently verified production-ready pure Go drop-in found in this review | More natural to integrate into Go SSH manager, but high protocol and interoperability development cost |

Sources:
- [trzsz-go ZMODEM requirements](https://trzsz.github.io/go.html)
- [kookob/rzsz Rust source](https://github.com/kookob/rzsz/blob/main/src/serial/terminal.rs), [reader](https://github.com/kookob/rzsz/blob/main/src/serial/reader.rs)
- [zmodem2 protocol API](https://docs.rs/zmodem2/latest/zmodem2/)

## What this spike proves

`experiments/native-zmodem` pins `zmodem2 = "=0.7.3"`; the GitHub Actions job on **Windows x64**:

1. Resolves and locks the actual dependency graph.
2. Compiles and runs a Windows executable and its tests using the Rust toolchain.
3. Confirms that the protocol crate's public `Action`, `FileInfo`, `Sender`, `Receiver` interfaces resolve on Windows.
4. Stores the generated `Cargo.lock` and dependency graph as reviewable CI artifacts, without copying its executable into the installer.

**It does not prove:** ZMODEM interoperability with remote `rz/sz`, progress accuracy, security, binary protocol correctness under SSH PTY, external process launch behavior, or any distribution/license clearance. This is an **API portability and build feasibility** gate only.

To reproduce:

```powershell
cd experiments/native-zmodem
cargo generate-lockfile
cargo test --locked
cargo build --locked --release
./target/release/openshell-zmodem-probe.exe
```

## Integration strategy (after Windows build succeeds)

1. **Transport boundary.** Introduce `ZmodemTransport` owning streaming binary input/output over an *exclusive* SSH PTY transfer window. Do not let normal terminal rendering or the existing `trzsz-go` filter concurrently consume protocol bytes.
2. **No live cutover.** `legacy` remains the default; the experimental native path must be opt-in in development builds only, and only for a newly started transfer. Once transfer starts, never switch implementations mid-stream.
3. **Lifecycle.** Implement both roles (remote `rz` means local sender, remote `sz` means local receiver); integrate picker, timeout, cancel, Ctrl-C, disconnect, remote process exit, and transfer events.
4. **Secure writes.** Normalize filenames and reject absolute paths, traversal, symlinks/reparse-point escapes, reserved Windows device names and unexpected overwrites. Write to temporary files and atomically publish on success.
5. **Interoperability.** Compare against real Linux `lrzsz` (Ubuntu/Debian/Rocky), test 0-byte/1-byte/binary/UTF-8 names, multi-file, 100 MB+, restart/resume, CRC/retransmit, weak networks, tmux/screen and JumpServer restrictions.
6. **Release decision.** Only after real end-to-end tests and license review pass may Windows packaging stop including the old DLL. Until then preserve all current behavior and disclosure.

## Cost trade-offs

Rust state-machine engine requires a Go↔Rust transport bridge (C ABI/FFI, subprocess protocol, or Go port). A subprocess adds a separate Windows binary but can still be **MSYS2-free**, and keeps crash/fault isolation. FFI complicates cgo, cross-compilation and packaging. A native Go port removes the language boundary but expands test and maintenance burden.

**Recommendation:** run the Windows protocol crate build probe first. If successful, prefer a **separate experimental Rust sidecar using stdio pipes** over FFI for initial interoperability tests; decide production integration only after those tests. The existing client continues using `trzsz-go + lrzsz-win32` unchanged.

## 验收状态

- [ ] Windows x64 原生协议库可编译、可运行（等待 Actions）
- [ ] 用真实 Linux `rz/sz` 完成收发互操作
- [ ] 文件名/取消/超时/弱网/安全写入测试
- [ ] 完成 Rust 依赖许可证清单、产物来源证明
- [ ] Windows 打包替换并完成回归测试

**No automatic user update, no release version change, no SignPath signing, no removal of MSYS2 in this spike.**
