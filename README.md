<div align="center">
  <img src="build/openshell-icon.svg" alt="OpenShell" width="88" height="88" />
  <h1>OpenShell</h1>
  <p><strong>SSH terminals, file transfers, and your own AI assistant — in one Windows app.</strong></p>
  <p>
    <a href="https://github.com/hctty27/openshell/releases/latest"><img src="https://img.shields.io/github/v/release/hctty27/openshell?label=release" alt="Latest release" /></a>
    <a href="https://github.com/hctty27/openshell/actions/workflows/ci.yml"><img src="https://github.com/hctty27/openshell/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
    <a href="https://github.com/hctty27/openshell/releases/latest"><img src="https://img.shields.io/badge/platform-Windows%20x64-0078D4" alt="Windows x64" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license" /></a>
  </p>
  <p><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>
  <p>
    <a href="https://github.com/hctty27/openshell/releases/latest">Download</a> ·
    <a href="#quick-start">Quick start</a> ·
    <a href="CHANGELOG.md">Changelog</a> ·
    <a href="https://github.com/hctty27/openshell/issues">Report an issue</a>
  </p>
</div>

OpenShell is a lightweight SSH and SFTP desktop client for developers and server administrators. Organize connections, work across terminal tabs and split panes, transfer files, and use an AI assistant with the API and model you choose.

**Status:** actively developed, pre-1.0 software. Windows x64 installers and portable packages are available. See the [release notes](https://github.com/hctty27/openshell/releases) for the changes and signing status of each build.

## Highlights

| Area | What you can do |
| --- | --- |
| SSH workspace | Open multiple tabs, duplicate a connection, split two terminals side by side or vertically, search output, and use interactive programs such as vim and top. |
| Session management | Organize connections in nested folders, search and edit sessions, authenticate with a password or local private key, import Xshell sessions, and export session backups. |
| Connection controls | Configure SSH keepalive and reconnection, disconnect manually, and return to a local Windows shell after disconnecting. |
| SFTP | Browse local and remote files, upload and download files or directories, resume transfers, edit remote text, preview one-way directory sync, and manage permissions. |
| Terminal file transfers | Use `rz` / `sz` with bundled Windows ZMODEM utilities; view transfer status in the sidebar. |
| AI assistant | Stream responses from a custom OpenAI-compatible API, review or automate remote commands, and keep conversation history shared across tabs for the same saved server. |
| Quick commands | Save reusable commands with categories, ordering, and global, folder, or session scope. Line breaks control when commands execute. |
| Appearance and language | Switch between English and Simplified Chinese, light and dark application themes, and independent classic, dark, or light terminal palettes. |

## Download

Get the latest build from **[GitHub Releases](https://github.com/hctty27/openshell/releases/latest)**.

| Package | Use |
| --- | --- |
| `OpenShell-vX.Y.Z-windows-x64-Setup.exe` | Install OpenShell on Windows. |
| `OpenShell-vX.Y.Z-windows-x64-portable.zip` | Extract the entire archive and run `OpenShell-vX.Y.Z.exe`. Keep the bundled `zmodem` directory beside it. |

The application requires [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/). The local terminal fallback uses Windows ConPTY. PowerShell 7 and WSL must be installed separately if you select them.

The portable package skips installation; settings and credentials still use your Windows user profile.

## Quick start

1. **Add a session.** Enter the host, port, username, and password or private-key details. Single-click a session to inspect it; double-click to connect.
2. **Verify the server.** Check the SSH host-key fingerprint before trusting the first connection. A changed trusted fingerprint blocks the connection.
3. **Choose your workspace.** Use tabs and split panes for terminals, or open SFTP from the terminal toolbar to manage files.
4. **Set your preferences.** In Settings, use **General** for language and application appearance, **Terminal** for terminal options, and **Connection** for keepalive, reconnection, and disconnect behavior.
5. **Configure AI when needed.** Under **AI Settings**, add an API profile, test the connection, and save it. Select the profile and execution mode in the AI sidebar.

The interface defaults to English; switch to Simplified Chinese in Settings → General. SSH and SFTP do not require an AI API key. You can edit a connected session: its name and folder update immediately, while host, port, user, and authentication changes apply on the next connection.

### Terminal workflow

- Double-click a connected tab to open another independent connection with the same session name. The `+` button opens the session picker.
- Connect two sessions, select the split partner, and switch between horizontal and vertical layouts. Drag the divider to resize the panes.
- Enable selection-to-copy and right-click paste in Settings if desired. Multiline paste can require confirmation.
- Choose a global terminal palette or override it per session; changes apply without reconnecting. The quick-command bar supports a single scrolling row or multiple rows.
- Configure disconnect behavior to return to a local shell, keep the disconnected tab, or close it. Local choices include Windows PowerShell, PowerShell 7, CMD, and WSL. Automatic reconnection applies to unexpected disconnects, not a manual disconnect.
- Use **Manage** in the quick-command bar to add commands. Each line break sends Enter; without a final line break, the last line is inserted without executing. Run these only when the terminal is ready to receive shell input.

## AI assistant

### Connect your API

| Setting | Value |
| --- | --- |
| Base URL | Your provider's Chat Completions-compatible base URL, for example `https://api.example.com/v1`. |
| API key | Your provider's key; it may be empty for a local service that does not require authentication. |
| Model name | The exact model ID accepted by your provider. |
| Tool calls | Enable only when both the provider and model support tools. Required for AI command execution. |

Remote endpoints require HTTPS. Local services can use HTTP on loopback addresses such as `127.0.0.1` or `::1`. Native Anthropic Messages and OpenAI Responses APIs are not supported directly; use a Chat Completions-compatible endpoint.

### Choose how commands run

| Mode | Behavior |
| --- | --- |
| Chat | Discuss a problem without executing commands. |
| Confirm | Review the target, working directory, and command before approving execution. You can edit or reject a proposal. |
| Automatic | Let AI execute commands and inspect results. By default, only recognized inspection commands run automatically; modifying, unrecognized, or repeated commands require confirmation. |

Automatic mode defaults to **10 commands per round**, configurable from 1–100. Continuing another round requires a click. Settings also let you allow modifying operations for new tasks. A task keeps its original server connection, API profile, and execution limits; disconnecting, reconnecting, or an unknown execution result stops the task.

**AI commands use a separate SSH exec channel.** They do not inherit a terminal's `cd`, temporary environment variables, virtual environment, or sudo state. Check the absolute remote working directory before execution; it defaults to the remote HOME. Quick commands instead type into the current interactive terminal and use its shell state.

Commands report stdout, stderr, exit code, and duration. The default timeout is 60 seconds, configurable from 1–600 seconds. Stop and timeout cancel waiting and further actions, but do not guarantee that a remote process has exited. A stalled channel setup may require disconnecting SSH. Use the interactive terminal for password prompts and other interactive commands. Markdown code blocks in chat are never executed automatically.

### Conversation memory and context

- Each saved server session owns multiple conversations. Tabs for that session share the list and can select different conversations; tabs viewing the same conversation see synchronized messages.
- New conversations remain drafts until the first message. History and summaries persist locally by default and can be disabled in AI settings.
- Only the tab that started a request controls its commands. Restoring history or reconnecting does not resume pending commands or automatic tasks. Clearing or deleting a conversation affects every tab viewing it.
- Turning history saving off uses temporary conversations and keeps existing saved history. Turning it back on restores saved history without importing temporary messages. Stop active tasks before switching storage mode.
- Long conversations use summaries plus recent turns within a **48 KiB request-data budget**, not an exact token limit. Summaries use your selected model and may incur provider charges; failed summarization falls back to bounded recent context.
- Selected terminal text or recent output is attached only after preview and confirmation. AI-executed commands also return their output to the model. Review what you send; automatic masking cannot catch every secret.

## Files and transfers

### SFTP

Open the file manager from a connected SSH tab. It reuses the authenticated connection and offers local/remote browsing, drag-and-drop transfers, a task queue, cancellation, retry, and verified-prefix resume.

- **Remote editing:** UTF-8 text files up to 1 MiB, with a remote-version check before saving.
- **Directory sync:** preview local-to-remote or remote-to-local changes based on size and modification time. Newer destination files are skipped; the current sync workflow does not delete files.
- **Permissions:** review and confirm changes for up to 200 selected items.
- **AI file assistance:** request analysis of selected configuration files, bounded log excerpts, or file differences. Review suggested edits in the editor before saving; upload suggestions still require confirmation.

### Open SFTP in the terminal's directory

OpenShell recognizes directory reports from **OSC 7**, **OSC 1337**, and **OSC 0/2 titles** such as `user@host:/path`. If the remote shell already reports its directory, no extra setup is needed. Otherwise SFTP falls back to the known initial directory, or its default directory if the reported path is unavailable. It does not inject hidden `pwd` commands into an interactive program.

<details>
<summary>Enable directory reporting for remote Bash</summary>

Add the following once to the remote `~/.bashrc`. It preserves an existing `PROMPT_COMMAND` and escapes URI-sensitive characters in the path.

```bash
__openshell_report_cwd() {
  local path="${PWD//%/%25}"
  path="${path//#/%23}"
  path="${path//\?/%3F}"
  printf '\033]7;file://%s%s\007' "${HOSTNAME:-localhost}" "$path"
}
if declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare -a'; then
  PROMPT_COMMAND+=(__openshell_report_cwd)
else
  PROMPT_COMMAND="${PROMPT_COMMAND:+${PROMPT_COMMAND};}__openshell_report_cwd"
fi
```

Reconnect to apply the change. Each new prompt reports the current directory; opening SFTP after `cd /some/path` uses that reported path.

</details>

### ZMODEM: `rz` / `sz`

Run `rz` on the remote host to choose local files to upload, or `sz /path/to/file` to choose a local destination for downloads. The remote host must have `lrzsz` installed. Official Windows packages include headless `rz.exe` / `sz.exe` launchers, with unmodified lrzsz binaries and `msys-2.0.dll` in `zmodem/native/`, as well as the original source and license notices. No Windows PATH setup is needed; the bundled launchers avoid opening an extra console window.

Transfer status appears in the sidebar's transfer area. Cancel through the transfer controls or Ctrl+C. Downloads use the `rz -E` rename strategy for existing filenames. Protocol payloads are filtered before terminal history and AI context. ZMODEM can be unreliable inside tmux/screen; use SFTP for directories and resumable transfers.

## Import and backup

| Source | What is included | What to configure again |
| --- | --- | --- |
| Xshell `.xts` / `.xsh` | SSH connection settings and folder structure; UTF-16 and UTF-8 files are supported. Preview and select sessions, then skip or rename duplicate names. | Passwords and private-key authentication. Xshell-encrypted credentials, Telnet, proxy, and jump-host settings are not imported. |
| OpenShell JSON backup | Saved SSH sessions and nested folders. Export and restore through Settings → General → Session backup. | Credentials and private-key files. AI profiles, API keys, appearance preferences, and conversation history are not included in session backups. |

To migrate from Xshell, export sessions, choose **Import Xshell** in OpenShell's session panel, review the import, and re-enter authentication details before connecting.

## Local data and privacy

| Data | Storage |
| --- | --- |
| Sessions, folders, API profile settings, preferences, trusted host keys | `%APPDATA%\OpenShell\state.db` |
| Saved AI conversations and summaries | The same local database; history saving is optional. |
| Passwords, API keys, private-key passphrases | Windows Credential Manager, under OpenShell entries. |
| Private keys | Your selected files; OpenShell stores their paths. |

Connections to SSH/SFTP servers and AI providers use the endpoints you configure. Prompts, attached excerpts, and AI command results sent to an AI provider are subject to that provider's policies. This program will not transfer information to other networked systems unless requested by the user or the person installing or operating it.

## Development

**Stack:** Go · Wails v2 · React · TypeScript · xterm.js · SQLite.

Use a Windows development environment with Go 1.26+, a current Node.js 22 release compatible with the locked Vite version, npm, and WebView2. Dependency versions are recorded in [go.mod](go.mod) and [frontend/package-lock.json](frontend/package-lock.json).

```sh
git clone https://github.com/hctty27/openshell.git
cd openshell
go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.0
cd frontend
npm ci
cd ..
wails dev
```

Build the Windows x64 executable:

```sh
wails build -platform windows/amd64 -clean
```

Output: `build/bin/OpenShell.exe`. A plain Wails build does not package the ZMODEM helpers. For the bundled utilities, run [scripts/prepare_zmodem_windows.ps1](scripts/prepare_zmodem_windows.ps1) in PowerShell after building. The [Windows release workflow](.github/workflows/windows-release.yml) contains the full icon-generation, installer, and portable-package steps.

<details>
<summary>Validation and release workflow</summary>

Run from the repository root:

```sh
go test -race ./...
go vet ./...
cd frontend
npm test -- --run
npm run build
npx playwright install chromium
npx playwright test
```

Backend tests use controlled SSH servers and mock APIs. Browser tests use a mock Wails bridge and do not replace native Windows acceptance testing.

- [CI](.github/workflows/ci.yml) runs Go race tests, `go vet`, frontend tests, a production frontend build, and selected Chromium regressions on pull requests and `main` pushes.
- [Windows terminal smoke](.github/workflows/windows-terminal-smoke.yml) covers relevant terminal, SSH, SFTP, and ConPTY pull requests.
- [Windows release](.github/workflows/windows-release.yml) publishes only after the release marker changes on `main` and CI passes. It retains three Releases, keeps older Git tags, and retains final build artifacts for seven days. Manual runs create artifacts without publishing a Release.

For a release, update `.github/release-version.txt`, `frontend/package.json`, `frontend/package-lock.json`, the fallback version in `frontend/src/App.tsx`, `wails.json`, and `CHANGELOG.md` together. Push to `main`; the workflow creates the tag after successful validation and packaging.

</details>

## Project notes

- Windows x64 is the currently delivered desktop platform. macOS and Linux desktop packages are not provided.
- ProxyJump/jump hosts, SSH agent authentication, cloud sync, and quick-command parameter placeholders are not currently supported.
- Native Windows input methods, clipboard behavior, credential storage, transfer edge cases, and performance require real-device validation. Tool-call compatibility depends on your API provider and model.
- Terminal-context attachments are limited to 200 lines / 32 KiB. A preview may omit a truncation notice if older terminal history was already trimmed.

For implementation details and verification scope, see [Windows acceptance](docs/windows-acceptance.md), [stability acceptance](docs/stability-acceptance.md), [conversation memory validation](docs/conversation-memory-validation.md), and [internationalization](docs/internationalization.md). These supporting documents currently include Chinese content.

Bug reports and focused pull requests are welcome. Include the OpenShell version, Windows version, reproduction steps, and redacted logs in an [issue](https://github.com/hctty27/openshell/issues). Keep the English and Chinese READMEs aligned when changing documented behavior.

## License and code signing

OpenShell is licensed under the **[MIT License](LICENSE)**. Bundled third-party components retain their own licenses; Windows ZMODEM utilities include GPL notices and corresponding source archives.

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

Signing is conditional on the required SignPath configuration and secrets being present. Otherwise, builds are unsigned. Check each Release's notes for its actual signing status. The application executable and installer are built through GitHub Actions; the portable ZIP contains the application executable. Only artifacts built from this repository's source code are submitted for signing.

**Committer, reviewer, and signing approver:** [hctty27](https://github.com/hctty27).
