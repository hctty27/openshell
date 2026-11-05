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

**The initial compile-only spike did not establish:** ZMODEM interoperability, SSH PTY correctness, security, progress events, or distribution compliance. The additional process-level tests documented below establish basic file-transfer interoperability in local pipes, **not** SSH/PTY integration.

To reproduce:

```powershell
cd experiments/native-zmodem
cargo generate-lockfile
cargo test --locked
cargo build --locked --release
./target/release/openshell-zmodem-probe.exe
```

## Validated real lrzsz interoperability (experimental sidecar)

The isolated `experiments/native-zmodem/src/bin/zmodem-sidecar.rs` provides a minimal
`send FILE` / `receive DIRECTORY` protocol adapter over stdin/stdout. Its stdout
contains only binary ZMODEM frames; operational diagnostics go to stderr.

**CI proof:** [Linux + Windows native ZMODEM workflow](https://github.com/hctty27/openshell/actions/runs/41988745564).

- `tests/roundtrip.rs`: 5 byte-stream protocol roundtrips between the independent `zmodem2` Sender and Receiver state machines.
- `tests/interop_lrzsz.py`: starts the **system-installed Linux lrzsz executables** and the independently compiled Rust sidecar as separate subprocesses, bridging their raw stdin/stdout pipes.
- Verifies both directions: Linux `sz` → Rust `receive`; Rust `send` → Linux `rz`.
- For each direction tests 0-byte, 1-byte, ~64 KiB, 2047-byte with 23-byte transport fragmentation, UTF-8 filename, and 1 MiB payloads — **12 cross-implementation transfers, all SHA-256 identical**.
- `tests/interop_sidecar.py`: on a **Windows Runner**, launches two separate native `zmodem-sidecar.exe` processes connected via Windows pipes. Verifies zero- and one-byte, UTF-8 filename and >1 MiB binary transfers — **4 additional transfers, all SHA-256 identical**.
- Both Windows x64 and Linux Rust build/test jobs passed. The isolated sidecar is **not** included in an installer or release asset.

Run the real Linux test locally:

```bash
sudo apt-get install lrzsz
cd experiments/native-zmodem
cargo generate-lockfile
cargo test --locked --test roundtrip
cargo test --locked --bin zmodem-sidecar
cargo build --locked --release --bin zmodem-sidecar
python3 tests/interop_lrzsz.py target/release/zmodem-sidecar
```

### Real SSH PTY experiment (Linux runner)

**CI evidence:** [OpenSSH PTY ↔ Rust sidecar, 10/10 SHA-256 verified](https://github.com/hctty27/openshell/actions/runs/41996088364).

- `ssh-pty-bridge/main.go` starts an **independent authenticated SSH session** with a pinned server host key and requests a PTY. The terminal is put into raw/no-echo mode before executing remote Linux `rz` or `sz`.
- The Go bridge forwards unmodified bytes between the SSH channel and `zmodem-sidecar`, with exactly one reader in each direction and a transfer deadline. Neither OpenShell's on-screen terminal nor its `trzsz-go` filter is modified.
- `tests/interop_ssh_pty.py` starts with a real loopback OpenSSH daemon in GitHub Actions and tests **both directions** using 0-byte, 1-byte, 64 KiB binary, Chinese filename and >1 MiB binary files: **10/10 SSH PTY transfers, SHA-256 identical**.
- Normal peer shutdown can cause a trailing `EPIPE` / closed-pipe result; the bridge tolerates these only after **both** native sidecar and remote lrzsz exit successfully. The experiment remains out of production builds and release artifacts.

**Not established yet:** integration with an existing OpenShell terminal's SSH PTY and
trzsz filter handoff, Windows native sidecar ↔ Linux remote SSH PTY, JumpServer,
multiple-file ZMODEM sessions, 100 MiB+ transfers, weak network/cancel/reconnect
behavior, production-safe path handling, progress UI and automated fallback.
The Linux test exercises an *independent SSH PTY*, not the already-running
interactive terminal. The Rust sidecar enforces a 128 MiB prototype limit and
supports one file per session; it must not be shipped as an OpenShell feature.

## Integration strategy (after real SSH/PTY test validation)

1. **Transport boundary.** Introduce `ZmodemTransport` owning streaming binary input/output over an *exclusive* SSH PTY transfer window. Do not let normal terminal rendering or the existing `trzsz-go` filter concurrently consume protocol bytes.
2. **No live cutover.** `legacy` remains the default; the experimental native path must be opt-in in development builds only, and only for a newly started transfer. Once transfer starts, never switch implementations mid-stream.
3. **Lifecycle.** Implement both roles (remote `rz` means local sender, remote `sz` means local receiver); integrate picker, timeout, cancel, Ctrl-C, disconnect, remote process exit, and transfer events.
4. **Secure writes.** Normalize filenames and reject absolute paths, traversal, symlinks/reparse-point escapes, reserved Windows device names and unexpected overwrites. Write to temporary files and atomically publish on success.
5. **Interoperability.** Compare against real Linux `lrzsz` (Ubuntu/Debian/Rocky), test 0-byte/1-byte/binary/UTF-8 names, multi-file, 100 MB+, restart/resume, CRC/retransmit, weak networks, tmux/screen and JumpServer restrictions.
6. **Release decision.** Only after real end-to-end tests and license review pass may Windows packaging stop including the old DLL. Until then preserve all current behavior and disclosure.

## Cost trade-offs

Rust state-machine engine requires a Go↔Rust transport bridge (C ABI/FFI, subprocess protocol, or Go port). A subprocess adds a separate Windows binary but can still be **MSYS2-free**, and keeps crash/fault isolation. FFI complicates cgo, cross-compilation and packaging. A native Go port removes the language boundary but expands test and maintenance burden.

**Recommendation:** the compilation, Windows local-pipe, Linux lrzsz pipe, and isolated Linux SSH PTY interoperability gates are now met. Next verify an **exclusive live OpenShell terminal handoff** and robust cancel/timeout handling before enabling an opt-in native path in development builds. Prefer keeping the Rust sidecar isolated over introducing FFI initially. The existing client continues using `trzsz-go + lrzsz-win32` unchanged.

## 验收状态

- [x] Windows x64 原生协议库可编译、可运行（[Actions #41985890935](https://github.com/hctty27/openshell/actions/runs/41985890935) 成功；仅协议 API 编译/EXE 冒烟验证，不代表实际文件传输成功）
- [x] Linux 本地管道环境下与真实 `lrzsz rz/sz` 双向收发，12/12 文件校验通过
- [x] Windows 原生 Rust 独立进程双向管道传输，4/4 文件 SHA-256 校验通过（尚非 SSH）
- [x] Linux 独立 SSH PTY 与真实远端 `rz/sz` 双向端到端收发，10/10 SHA-256 通过
- [ ] 在 Windows OpenShell 已打开的 SSH PTY 中与真实远端 `rz/sz` 端到端收发
- [ ] 文件名/取消/超时/弱网/安全写入测试
- [ ] 完成 Rust 依赖许可证清单、产物来源证明
- [ ] Windows 打包替换并完成回归测试

**No automatic user update, no release version change, no SignPath signing, no removal of MSYS2 in this spike.**
