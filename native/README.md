# OpenShell Native 2.0 (experimental)

A new Rust implementation alongside the existing Go/Wails version. **Not a replacement release.** Current Windows installers and existing data stay untouched.

## Architecture

- openshell-core: validated session domain, local SQLite metadata, Alacritty ANSI state machine, Russh/Tokio SSH transport.
- openshell-native: experimental GPUI desktop with multiple concurrently running terminal tabs. Rendering is still a styled-text prototype, not a production GPU cell renderer.
- Windows x64 primary target.

## Build on Windows

Install stable Rust and Visual Studio C++ Build Tools with the Windows SDK. From the repository root:

    cd native
    cargo test -p openshell-core
    cargo check -p openshell-native
    cargo run -p openshell-native
    cargo run --release -p openshell-core --example terminal_bench

## Implemented

- GPU-backed GPUI workspace with an experimental ANSI-styled text-cell snapshot and independent local/remote tab state.
- Alacritty terminal parser with partial-sequence state maintained across writes, plus renderer-neutral cell colors, text style, cursor state and device-status replies.
- PowerShell startup through portable-pty/Windows ConPTY in an off-UI worker, bounded I/O, ANSI-styled text output displayed in GPUI and basic direct keyboard input.
- Grouped GPUI text highlights and coalesced PTY output to reduce redundant frame work.
- GPUI window bounds now update the terminal grid and ConPTY dimensions. Temporary column widths are estimates, not font-shaped metrics.
- Primary-screen scrollback with wheel and Shift+PageUp/PageDown; alternate-screen mouse reporting remains incomplete. Run the ANSI microbenchmark before claiming speedups.
- Bounded byte-oriented Russh/Tokio SSH channel, password authentication requiring previously verified SHA256 host fingerprint.
- SQLite CRUD of non-secret session metadata in independent native_sessions table.
- Read-only preview of legacy Wails sessions (including auth configuration and credential references). No automatic data migration or credential extraction.
- Native SSH session metadata and explicit SHA256 host trust, Windows Credential Manager password storage, clickable saved-session sidebar and SSH connection lifecycle controls.
- Concurrent terminal tabs: each owns its Alacritty grid/scrollback, ConPTY or SSH transport, background output task, status and cancellation. Clicking a saved server opens a new SSH tab rather than replacing another session.
- Tab strip allows select/close, additional local PowerShell tabs, keyboard tab navigation and close confirmation for active running terminals. Closing the final tab creates a fresh local PowerShell.

## Not implemented yet

- Production GPU cell painting, precise monospace glyph measurement, CJK/IME composition, full mouse reporting, selection, clipboard, and resize performance/accuracy. Basic input and local scrollback exist only as a prototype.
- End-user session editor, host-key approval UI, public-key login and reconnect policy. The initial Windows credential vault and saved-session selection are implemented, but not independently tested through live GUI interactions.
- Private-key/agent authentication, automatic SSH reconnection/backoff, port forwarding and keepalive. Manual reconnect is available for saved sessions.
- SFTP file browser/transfers, rz/sz and additional Windows shells/WSL integration.
- AI provider tools and multi-session automation, conversation storage.
- Tab drag-reorder, split panes, saved tab restoration, Xshell import, i18n, themes and native installer.
- End-to-end Windows validation and verified performance comparisons.

## Non-negotiable migration principles

1. Do not replace production Wails code or release workflows before feature parity and Windows acceptance.
2. Never accept unknown SSH host keys without an explicit human approval; reject changed keys.
3. Never store passwords, private-key passphrases or API tokens in the SQLite database or logs.
4. Terminal data remains binary-safe; no JS/Base64 bridge.
5. Bound every async queue; do not run disk or SSH operations on the GPU frame thread.
6. Make a read-only backup of the existing AppData/OpenShell/state.db before migrating data.
7. Review licenses and provide dependency notices before distribution.

## Saved SSH sessions and host verification (developer workflow)

The new native runtime stores non-secret session metadata and explicitly
approved SHA256 host-key fingerprints in a **separate** SQLite database:

`%LOCALAPPDATA%\OpenShellNative2\native.db`

SSH passwords use the **Windows Credential Manager**, under the service
`OpenShell.Native2.SSH`. These secrets are not inserted into SQLite or
recovered from the existing Wails credentials.

With Rust installed, open PowerShell in the repository root:

```powershell
cd native
cargo run -p openshell-core --example sessionctl -- add server1 "My server" example.org 22 root
cargo run -p openshell-core --example sessionctl -- list
cargo run -p openshell-core --example sessionctl -- trust server1 SHA256:YOUR-INDEPENDENTLY-VERIFIED-SERVER-FINGERPRINT
cargo run -p openshell-core --example sessionctl -- password server1
cargo run -p openshell-native
# Click "server1" in the Saved SSH sessions sidebar to open a new SSH tab.
# Click another server entry to open another independent SSH tab.
# Click "+ Local" to open another PowerShell tab.
# Use Ctrl+Tab / Ctrl+Shift+Tab to switch, Ctrl+T for local, Ctrl+W to close.
# Closing a running terminal asks for confirmation.
# The active SSH tab has Cancel / Disconnect / Reconnect controls.
```

The `trust` command asks for an explicit `TRUST` confirmation. Verify the
fingerprint out-of-band first. A changed or unknown host key cannot be silently
accepted: the Russh connection enforces the stored fingerprint. The `password`
command reads input without terminal echo; no password is entered on a command
line or stored in shell history.

The GPUI sidebar lists saved sessions with click-to-open-in-a-new-tab and a **Refresh list**
button (useful after adding sessions from the CLI). The active tab status toolbar shows connection and termination status. During an SSH
handshake, **Cancel connection** interrupts the actual Russh worker and not
just GUI delivery. Once connected, **Disconnect SSH** asks the channel to
close gracefully; use **Force cancel** if closure stalls. A disconnected saved
session offers **Reconnect SSH** (manual retry only, with the same independently
approved host fingerprint). **Back to local** is available to restart ConPTY.
Clicking another saved session explicitly cancels the previous SSH worker and
replaces its GUI output stream.
The prior `OPENSHELL_SSH_SESSION_ID` environment variable remains available
for development-only automated startup but is not required for normal preview
selection.

The saved-session editor and host-key approval UI are **not yet implemented**.
The SSH worker reads saved credentials **off the UI thread**. The cancel
signal can abort network connection, authentication and PTY operation; native
SQLite and OS credential retrieval remain synchronous inside the worker and
cannot be pre-empted mid-system call. Live Windows GUI and SSH-server
acceptance tests are still required. Do not use this prototype on
production servers.

Deleting a saved session from the development CLI also removes its Windows
credential entry, but keeps host:port trust intact because multiple SSH user
accounts can share a server. Trust revocation and UI confirmation are future
features.

## Opt-in SSH terminal smoke test (development only)

The current GPUI terminal can now use the Russh transport instead of PowerShell
**only when all explicit SSH test environment variables are present**. It is
not the future SSH session editor and it never silently imports a stored password.

On **PowerShell 7**, in a fresh terminal, use a disposable test account:

```powershell
$env:OPENSHELL_SSH_TEST_HOST = "test-server.example"
$env:OPENSHELL_SSH_TEST_PORT = "22"
$env:OPENSHELL_SSH_TEST_USER = "test-user"
$env:OPENSHELL_SSH_TEST_FINGERPRINT = "SHA256:replace-with-independently-verified-fingerprint"
$env:OPENSHELL_SSH_TEST_PASSWORD = Read-Host "Temporary test SSH password" -MaskInput
cargo run -p openshell-native
Remove-Item Env:OPENSHELL_SSH_TEST_PASSWORD
```

The fingerprint must be verified independently against the server administrator
or local host public key. Do not derive trust from an unverified network lookup.
The test password remains in the process environment, so this mode is **not
suitable for routine use or production deployments**. Never include real
credentials in shell history, files, bug reports, or CI logs.

For a headless protocol check, run
`cargo run -p openshell-core --example ssh_smoke` with the same variables.
It exercises login, shell PTY, input, resize, and output without revealing
the password or printing the remote command output.

The normal startup path (variables absent) remains local PowerShell/ConPTY.
Remote SSH currently has no interactive credential/host approval UI, key/agent
login or automatic reconnect controls. Saved-session selection is available as
an experimental click-to-connect sidebar. The Windows CI compiles
the test example but cannot authenticate against your private server.

## Windows multi-tab smoke-test checklist

After CI uploads the Debug EXE, validate on a disposable Windows development machine:

1. Open two local PowerShell tabs. Run a different long-lived command in each,
   switch repeatedly with Ctrl+Tab and check that output stays independent.
2. Add two disposable SSH test servers via `sessionctl`, then click both in
   the sidebar. Confirm each retains its own cursor, shell history and status.
3. Close a running SSH tab, reject the close confirmation, then explicitly
   confirm it. Verify only the selected SSH connection is disconnected.
4. Resize the window while several terminal sessions run, including an SSH
   session in an inactive tab. Verify all PTY sizes adjust correctly.
5. Close the last tab. Verify a clean local PowerShell tab opens automatically.
6. Test Cancel/Disconnect/Reconnect, wrong host fingerprints and slow login.
7. Check memory, p95 input latency and large-output behavior versus Wails
   on the same test machine. **These have not yet been measured.**

The desktop prototype does not persist open tabs across restarts and cannot
yet perform split panes, drag sorting, selection/copy/paste or CJK IME. Only
use test hosts; do not migrate production credentials into the prototype.

## Windows developer preview

The native CI builds a **debug-only, unsigned** `openshell-native.exe` and uploads it
as the short-lived `openshell-native-unsigned-debug-windows-x64` GitHub Actions artifact.
This is for manual keyboard, resize and ConPTY smoke tests only. It is not an
installer, a release candidate, or a performance benchmark build.
Only test it on a development machine and do not overwrite the stable Wails app.

## Release gates

Compare with the current release on an identical Windows machine and server: cold start, idle and 10-tab memory, streamed-log throughput, p95 keyboard latency, split/tab switch frame time, SFTP large-file and 10,000-entry directory behavior. No untested speed claims.
