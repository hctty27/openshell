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
- Windows system-clipboard paste using Ctrl+V, Ctrl+Shift+V, Shift+Insert, terminal right-click or the Paste button; bracketed paste protocol is honored when enabled by the terminal application. Multiline/large paste requires a confirmation tied to the original terminal tab. Ctrl+Shift+C and Copy viewport copy **visible terminal text**, not a mouse selection. Clipboard escape controls and pasted content over 128 KiB are rejected.
- Bounded byte-oriented Russh/Tokio SSH channel, password authentication requiring previously verified SHA256 host fingerprint.
- SQLite CRUD of non-secret session metadata in independent native_sessions table.
- Read-only preview of legacy Wails sessions. An explicit `sessionctl import-legacy` command now creates a consistent SQLite snapshot and imports non-secret session metadata without overwriting existing native sessions; credentials and auth settings must still be configured separately.
- Native SSH session metadata and explicit SHA256 host trust, Windows Credential Manager password storage, clickable saved-session sidebar and SSH connection lifecycle controls.
- Optional unencrypted local OpenSSH private-key authentication per saved SSH session, configured by `sessionctl key <id> <path>`. Only the canonical file path is stored in native SQLite, never the key bytes. Key login takes precedence over saved password; `key-clear` restores password login. Host-key pinning is enforced for both modes.
- The session sidebar is vertically scrollable to keep long credential, fingerprint and session forms accessible at standard window sizes.
- Create and edit session metadata directly in the GPUI sidebar; persistence runs off the UI thread. The editor can also configure a local unencrypted private-key path or switch a session back to password authentication (existing keys remain untouched when the field is left blank). The GUI supports masked password entry stored in Windows Credential Manager on a background worker (blank leaves an existing password unchanged); a new, independently verified SHA256 host-key fingerprint may be approved from the GUI only after an explicit confirmation; changing an existing pinned fingerprint is blocked in the GUI (including concurrent writes via an insert-only SQLite conflict policy) and still requires the separate CLI workflow. Edits take effect on new SSH connections.
- Concurrent terminal tabs: each owns its Alacritty grid/scrollback, ConPTY or SSH transport, background output task, status and cancellation. Clicking a saved server opens a new SSH tab rather than replacing another session.
- Tab strip allows select/close, additional local PowerShell tabs, keyboard tab navigation and close confirmation for active running terminals. Closing the final tab creates a fresh local PowerShell.

## Not implemented yet

- Production GPU cell painting, precise monospace glyph measurement, CJK/IME composition, full mouse reporting, mouse-based text selection/copy, and resize performance/accuracy. Basic keyboard clipboard paste and viewport copy are available, but arbitrary selection/copy is not.
- Complete session management (delete, group, duplicate), host-key approval UI, public-key login and reconnect policy. The initial Windows credential vault and saved-session selection are implemented, but not independently tested through live GUI interactions.
- Encrypted private-key passphrases and SSH Agent authentication, automatic SSH reconnection/backoff, port forwarding and keepalive. Unencrypted local OpenSSH private-key login is available for saved sessions through the `sessionctl key` command. Manual reconnect remains available.
- SFTP file browser/transfers, rz/sz and additional Windows shells/WSL integration.
- AI provider tools and multi-session automation, conversation storage.
- Nested split panes, draggable split divider, visual drag drop zones, saved tab restoration, direct Xshell import, i18n, themes and native installer. Initial tab reorder and two-pane drag-to-split prototypes exist; Wails metadata migration is currently a CLI-only opt-in.
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
# Optional: choose an existing unencrypted OpenSSH private key for this session:
# cargo run -p openshell-core --example sessionctl -- key server1 "C:\\Users\\me\\.ssh\\id_ed25519"
# cargo run -p openshell-core --example sessionctl -- key-clear server1
# Optional Wails migration (safe metadata-only import, no credentials):
# cargo run -p openshell-core --example sessionctl -- import-legacy "$env:APPDATA\\OpenShell\\state.db"
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

After CI uploads the standalone Release preview EXE, validate on a disposable Windows development machine:

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
7. Drag one SSH tab into another terminal pane at left/right and top/bottom;
   drag a tab onto another tab title to reorder. Confirm connections remain
   active, no duplicate SSH channels are opened, and the tab strip order persists
   until exit. Create splits with two SSH sessions; confirm both continue
   outputting and window resize sends correct PTY dimensions to each pane. Unsplit
   and verify neither remote session was interrupted.
8. Check memory, p95 input latency and large-output behavior versus Wails
   on the same test machine. **These have not yet been measured.**

The desktop prototype does not persist open tabs across restarts and cannot
yet perform split panes, drag sorting, selection/copy/paste or CJK IME. Only
use test hosts; do not migrate production credentials into the prototype.

## Split terminal prototype (experimental)

The GPUI workspace now has an explicit **two-pane view** of existing local
PowerShell or SSH tabs. This is **presentation-only**: splitting never clones,
reconnects or disconnects either terminal. Each pane retains its own Alacritty
history, PTY/SSH channel and I/O worker.

- Open at least two terminal tabs. **Drag a tab by its title into an existing
  terminal pane** to create a two-pane split. Dropping onto the left or right
  part of the pane creates side-by-side panes; drop near the top or bottom to
  stack the panes. The tab's original SSH/ConPTY connection stays running.
- **Drag a tab title onto another tab title** to reorder the tab strip without
  disconnecting either terminal.
- Click a pane to focus its existing tab; only the focused tab receives keys.
- Use **Unsplit** to return to the normal single-terminal view without ending
  either connection.
- Resizing the main window or changing split orientation updates the visible
  terminals' PTY row/column dimensions independently.
- Closing either of the split tabs exits split mode; the confirmation banner
  still applies to connected tabs.

Implementation boundaries: `terminal_tab.rs` owns connection/cursor/scrollback
state, `terminal_paint.rs` owns diagnostic rendering and viewport sizing,
`split_view.rs` owns presentation-only split membership, while
`ssh_preview.rs` manages the SSH development worker. The GPUI workspace still
requires additional refactoring before production.

**Not yet available:** precise visual split drop-zone highlighting, nested
splits, resizing the divider, separate pane zoom, CJK/IME, correct glyph metrics,
clipboard, SFTP or AI across panes. Drag/drop APIs compile in Windows CI but
still require manual pointer-event testing on a real Windows desktop. The split UI must pass Windows CI and be
manually tested with concurrent SSH sessions before it can be considered stable.

## Windows startup failure: DirectWriteTextSystem

If a previous unsigned Debug EXE displays **"Failed to launch / Error creating
DirectWriteTextSystem"**, the native GPUI window has not been created yet.
This is a Windows DirectWrite/Direct3D initialization error, **not** an SSH,
ConPTY, or session data failure. CI only compiles and unit-tests the app;
GUI startup depends on the actual Windows graphics/font environment.

Download a fresh artifact that includes the independent diagnostic command.
From PowerShell in the extracted directory, run:

```powershell
.\openshell-native.exe --diagnose
Get-Content "$env:TEMP\openshell-native-directwrite-diagnostic.txt"
dxdiag
```

The --diagnose mode deliberately **does not construct GPUI or open an SSH
connection**. It tests DirectWrite Factory5, font-loader and collections,
**then enumerates DXGI GPU adapters in GPUI's order** and attempts a D3D11
device plus StructuredBuffer capability check on each adapter. It reports the
first GPU that satisfies the basic GPUI requirements and individual Windows
HRESULT failures, and writes the complete results to a text file in Temp.
This is a read-only diagnostic: it does not disable or install GPU drivers.

- If DirectWrite initialization fails, the report identifies the failing
  Windows API and HRESULT. Check OS version/Windows font services.
- If all DirectWrite tests pass but the app still fails on launch, the
  remaining possibility includes GPU-backed emoji/text shader creation
  inside GPUI. Check the GPU name, installed driver and DirectX 11 feature
  levels in **dxdiag**; update graphics drivers from the hardware vendor
  rather than copying random DLLs into the program directory.
- This diagnostic does **not** prove the real GPU shader initialization
  works; it deliberately isolates the Windows font API portion only.

Share the report and the Display tab's driver/feature-level information
(redact personal PC information if desired) for the exact next fix.

## Windows developer preview — use RELEASE, not DEBUG

**Important fix (2026-10-29):** The GPUI Windows Debug shader path can use
`D3DCompileFromFile` and a baked-in absolute `CARGO_MANIFEST_DIR` source
path (from the GitHub build runner). Moving only the Debug EXE to another
computer leaves the HLSL source files behind, causing startup to fail with the
outer error `Error creating DirectWriteTextSystem`.

**Release mode embeds precompiled HLSL shader bytecode**, and therefore does
not depend on the original GitHub runner's shader source paths at runtime.
For Windows user testing, CI now runs `cargo build --release -p openshell-native`
and uploads the unsigned
`openshell-native-unsigned-release-preview-windows-x64` artifact.

This Release **preview** is not a signed installer, not a production release and
still has incomplete SSH/terminal functionality. It is only the correct portable
build type to smoke-test GPUI window startup, compared to the previous Debug EXE.
It retains the `--diagnose` command for DirectWrite/DXGI diagnostics.

If you need local Debug development, run it on the same machine where the
GPUI source/HLSL shader files were built; never distribute the GitHub runner's
standalone Debug EXE to end users.



## Native SFTP transport (experimental)

SFTP now uses a dedicated authenticated Russh channel and the `russh-sftp`
subsystem, not the terminal's PTY. This first step exposes asynchronous
directory listing and streaming upload/download from a developer CLI.
No full SFTP GUI, file picker, transfer dock, cancellation/progress UI, rz/sz,
remote directory tracking or drag-and-drop has been implemented yet.

Use on a disposable test server only:

```powershell
cd native
cargo run -p openshell-core --example sftpctl -- list server1 .
cargo run -p openshell-core --example sftpctl -- download server1 /tmp/test.txt "$env:TEMP\test.txt"
cargo run -p openshell-core --example sftpctl -- upload server1 "$env:TEMP\test.txt" /tmp/new-test.txt
```

SFTP shares the saved session's pinned host key and uses either its Windows
Credential Manager password or configured local OpenSSH private key. Uploads
use CREATE + EXCL and do not overwrite an existing remote target. Downloads
use create_new and do not overwrite existing local files; failed transfers
attempt to delete their partial local output. A long-running interrupted
upload may leave a partial remote file requiring manual cleanup.


### Native GUI SFTP directory preview

Each saved SSH session now has an **SFTP** action. A right-side GPUI browser
lists the remote directory, supports folder navigation, Up and Refresh, and
uses a separate SSH connection so the currently running terminal is not
restarted. Directory enumeration runs on a background worker using one persistent SSH/SFTP channel for the lifetime of the panel (refresh and folder changes reuse it; errors allow explicit reconnect on Refresh). This initial
GUI does **not** yet implement file picker upload/download or transfer
progress; use `sftpctl` for initial transfer testing.


### Native SFTP queue (experimental)

The right-side SFTP panel now retains one authenticated browser connection
for directory changes, and maintains a sequential transfer queue of up to
12 waiting file uploads/downloads. It shows byte progress for the active
file and a bounded six-entry result history. A new upload/download selection
made during an active transfer goes into the queue. The user can cancel the
running transfer independently or clear the pending queue. Closing the
SFTP panel cancels the active operation and discards queued work. Transfer
jobs use independent SSH connections from the shared browser session, so
file copies do not interrupt terminal output or folder navigation. The
queue is in-memory only (not resumed across restarts); overwrite remains
explicitly forbidden. Real Windows interaction and SSH/SFTP server tests
are still required before a production release.


### SFTP current directory follows the SSH terminal (experimental)

Native terminals now parse OSC 7 (file://host/absolute/path) and strict OSC 0/2
titles such as `user@server:/data/app`. OSC 7 takes precedence once observed.
The state machine handles split transport chunks, BEL/ST terminators, escaped
UTF-8 path components and bounded OSC payloads. Arbitrary title strings are
not interpreted as paths.

Opening the right-side SFTP browser for a saved SSH session uses the current
directory of that session's connected terminal tab, if one has reported a
valid path. Otherwise SFTP opens its normal server directory. While following
is enabled, new directory reports update the SFTP path. Explicit SFTP folder
navigation pauses following until the user enables it again. The SFTP browser
and PTY remain separate connections; no hidden `pwd` command is executed.

Shell integration is required to emit OSC 7 or a matching title. Nested SSH,
tmux, or other remote applications may report paths for a different machine;
users should verify that the SFTP server is the intended host.


### Experimental native terminal mouse selection

The terminal now uses Alacritty's own per-grid selection state rather than
copying the whole viewport for every mouse gesture. Left-button drag selects
cells and highlights the selection; releasing copies the non-empty selection
to the Windows clipboard. Ctrl+Shift+C and the toolbar Copy action prefer
the active selection, falling back to visible-viewport copy when no selection
is present. Each SSH/PowerShell tab owns an independent selection, including
while scrolling history. Right-click paste is unchanged.

The current GPUI diagnostic renderer still estimates glyph columns using a
fixed 8.5 px width; **pointer accuracy for proportional glyphs, CJK width,
DPI scaling, split panes and the SFTP dock is not production-quality yet**.
Terminal applications that advertise mouse mode reserve ordinary mouse
gestures; holding Shift allows a forced text selection. Full application
mouse event forwarding, IME and pixel-accurate glyph hit testing remain
release blockers. This is not yet a replacement for Xshell's selection UX.

### ZMODEM rz/sz handshake recognition (first native integration stage)

The Rust core now detects valid CRC16 ZMODEM **HEX startup headers** (ZRQINIT
from remote `sz`, ZRINIT from remote `rz`) across arbitrarily split SSH
transport chunks. Detection state belongs to each SSH tab and is reset on
reconnect. Ordinary terminal data is not consumed or rewritten, so a ZMODEM
frame cannot silently switch an interactive terminal into a binary transfer.
The GPUI pane displays the detected operation and offers **Cancel remote
rz/sz** (Ctrl+C on that exact SSH channel) and, for saved connections,
**Cancel rz/sz + Open SFTP** as a supported file-transfer alternative.

**This is detection and recovery, not rz/sz file transfer.** No automated
ZMODEM sender, receiver, file picker or binary-stream ownership exists yet.
Do not claim `rz` or `sz` uploads/downloads are supported until the
protocol state machine has been integrated and tested with actual `lrzsz`.
Protocol adoption will require exclusive binary stream dispatch, CRC/timeout
handling, explicit local destination, progress, cancellation, and cleanup.
