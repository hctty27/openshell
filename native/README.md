# OpenShell Native 2.0 (experimental)

A new Rust implementation alongside the existing Go/Wails version. **Not a replacement release.** Current Windows installers and existing data stay untouched.

## Architecture

- openshell-core: validated session domain, local SQLite metadata, Alacritty ANSI state machine, Russh/Tokio SSH transport.
- openshell-native: native GPUI desktop window. Currently the **experimental local terminal preview**; terminal rendering integration is not complete.
- Windows x64 primary target.

## Build on Windows

Install stable Rust and Visual Studio C++ Build Tools with the Windows SDK. From the repository root:

    cd native
    cargo test -p openshell-core
    cargo check -p openshell-native
    cargo run -p openshell-native
    cargo run --release -p openshell-core --example terminal_bench

## Implemented

- GPU-backed GPUI workspace with an experimental read-only text-cell snapshot.
- Alacritty terminal parser with partial-sequence state maintained across writes, plus renderer-neutral cell colors, text style, cursor state and device-status replies.
- PowerShell startup through portable-pty/Windows ConPTY in an off-UI worker, bounded I/O, ANSI-styled text output displayed in GPUI and basic direct keyboard input.
- Grouped GPUI text highlights and coalesced PTY output to reduce redundant frame work.
- GPUI window bounds now update the terminal grid and ConPTY dimensions. Temporary column widths are estimates, not font-shaped metrics.
- Primary-screen scrollback with wheel and Shift+PageUp/PageDown; alternate-screen mouse reporting remains incomplete. Run the ANSI microbenchmark before claiming speedups.
- Bounded byte-oriented Russh/Tokio SSH channel, password authentication requiring previously verified SHA256 host fingerprint.
- SQLite CRUD of non-secret session metadata in independent native_sessions table.
- Read-only preview of legacy Wails sessions (including auth configuration and credential references). No automatic data migration or credential extraction.

## Not implemented yet

- Production GPU cell painting, precise monospace glyph measurement, CJK/IME composition, full mouse reporting, selection, clipboard, and resize performance/accuracy. Basic input and local scrollback exist only as a prototype.
- End-user session editor, known_hosts approval UI and system credential vault.
- Private-key/agent authentication, SSH reconnection, port forwarding and keepalive.
- SFTP file browser/transfers, rz/sz and additional Windows shells/WSL integration.
- AI provider tools and multi-session automation, conversation storage.
- Xshell import, drag-to-split, i18n, themes and native installer.
- End-to-end Windows validation and verified performance comparisons.

## Non-negotiable migration principles

1. Do not replace production Wails code or release workflows before feature parity and Windows acceptance.
2. Never accept unknown SSH host keys without an explicit human approval; reject changed keys.
3. Never store passwords, private-key passphrases or API tokens in the SQLite database or logs.
4. Terminal data remains binary-safe; no JS/Base64 bridge.
5. Bound every async queue; do not run disk or SSH operations on the GPU frame thread.
6. Make a read-only backup of the existing AppData/OpenShell/state.db before migrating data.
7. Review licenses and provide dependency notices before distribution.

## Release gates

Compare with the current release on an identical Windows machine and server: cold start, idle and 10-tab memory, streamed-log throughput, p95 keyboard latency, split/tab switch frame time, SFTP large-file and 10,000-entry directory behavior. No untested speed claims.
