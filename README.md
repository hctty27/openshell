<div align="center">

  <img src="build/openshell-icon.svg" alt="OpenShell" width="76" height="76" />

  # OpenShell

  **A focused SSH workspace for Windows.**

  Manage servers, work across terminals, transfer files, and bring your AI tools into the workflow.

  [Download for Windows](https://github.com/hctty27/openshell/releases/latest) ·
  [Website](https://openshell.testnb.me/) ·
  [Documentation](docs/user-guide.md) ·
  [简体中文](README.zh-CN.md)

  [![Latest release](https://img.shields.io/github/v/release/hctty27/openshell?label=release)](https://github.com/hctty27/openshell/releases/latest)
  [![CI](https://github.com/hctty27/openshell/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hctty27/openshell/actions/workflows/ci.yml)
  [![Windows x64](https://img.shields.io/badge/platform-Windows%20x64-647f35)](https://github.com/hctty27/openshell/releases/latest)
  [![MIT License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

<p align="center">
  <img src="docs/screenshots/01-workspace-overview.png" alt="OpenShell workspace with SSH sessions, terminal, SFTP and AI assistant" width="100%" />
</p>

OpenShell is a free, open-source Windows desktop application for developers and server administrators. It brings multi-session SSH, split terminals, SFTP, native Rust ZMODEM, Xshell session import, and optional AI assistance into one workspace.

## One workspace, four core tools

| SSH workspace | SFTP file manager |
| --- | --- |
| ![SSH split terminals](docs/screenshots/02-split-terminals.png) | ![SFTP file manager](docs/screenshots/04-sftp-file-manager.png) |
| Organize sessions in tabs, split panes, search terminal output, and reconnect when needed. | Browse local and remote files, batch-transfer data, edit remote text, and manage transfer tasks. |

| Native Rust ZMODEM | AI assistance |
| --- | --- |
| ![Native ZMODEM transfer](docs/screenshots/05-native-zmodem-transfer.png) | ![Global AI assistant](docs/screenshots/03-ai-assistant.png) |
| Use `rz` / `sz` through the native Windows Rust engine. | Use a compatible model API with the global assistant or the active terminal. |

## Highlights

- **SSH sessions:** tabs, nested folders, duplicate connections, drag-reordering, horizontal and vertical splits, output search, and reconnect behavior.
- **SFTP:** local and remote browsing, batch upload/download, remote text editing, transfer queue, retry, and one-way directory-sync preview.
- **Native transfers:** Rust-native Windows ZMODEM for `rz` / `sz`; `trz` / `tsz` support when `trzsz` is installed on the remote host.
- **AI, when you want it:** configure a compatible model API for the global assistant or Terminal AI. SSH and SFTP work without AI configuration.
- **Xshell migration:** import supported Xshell SSH sessions and folder structures.
- **Local-first credentials:** session data stays in the local application profile; passwords and private-key passphrases use Windows Credential Manager.

## Download

Get the latest Windows x64 build from **[GitHub Releases](https://github.com/hctty27/openshell/releases/latest)**.

| Package | When to choose it |
| --- | --- |
| Windows installer (`*-Setup.exe`) | Recommended for normal installation. |
| Portable ZIP (`*-portable.zip`) | Extract the complete archive and run the application. Keep the bundled `zmodem` directory beside it. |

OpenShell requires [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/). Check each release's notes for its actual code-signing status; do not assume every build is signed.

## Get started

1. Download and install OpenShell, or extract the portable package.
2. Add an SSH session with the host, port, username, and password or private-key details.
3. Verify the SSH host-key fingerprint on the first connection.
4. Open a terminal, split the workspace, or launch SFTP from the connected session.

For detailed setup, AI configuration, SFTP, ZMODEM, Xshell import, privacy, troubleshooting, and development instructions, see the **[User Guide](docs/user-guide.md)**.

## Project status

OpenShell is in its v1.0 stable-release stage and is actively maintained. The current desktop release targets Windows x64; macOS and Linux desktop packages are not provided.

- [Changelog](CHANGELOG.md)
- [Privacy policy](PRIVACY.md)
- [Code-signing policy](CODE_SIGNING_POLICY.md)
- [Third-party license review](docs/third-party-review.md)
- [SBOM and binary inventory](docs/sbom.md)
- [Report a bug](https://github.com/hctty27/openshell/issues)

## Contributing

Bug reports and focused pull requests are welcome. Include the OpenShell version, Windows version, reproduction steps, and redacted logs when reporting an issue. Keep the English and Chinese project documentation aligned when changing user-visible behavior.

## License

OpenShell is licensed under the [MIT License](LICENSE). Bundled third-party dependencies retain their respective licenses; see the [SBOM](docs/sbom.md) and [third-party review](docs/third-party-review.md).
