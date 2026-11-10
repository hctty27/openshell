<div align="center">

<img src="build/openshell-icon.svg" alt="OpenShell" width="76" height="76" />

# OpenShell

**一个专注于服务器工作的 Windows SSH 工作空间。**

SSH 多会话 · SFTP 文件管理 · Rust 原生 ZMODEM · 可选 AI 助手

[下载最新版](https://github.com/hctty27/openshell/releases/latest) · [官方网站](https://openshell.testnb.me/) · [English](README.md) · [更新记录](CHANGELOG.md)

[![Latest release](https://img.shields.io/github/v/release/hctty27/openshell?label=Release)](https://github.com/hctty27/openshell/releases/latest)
[![CI](https://github.com/hctty27/openshell/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hctty27/openshell/actions/workflows/ci.yml)
[![Windows x64](https://img.shields.io/badge/platform-Windows%20x64-202a25)](https://github.com/hctty27/openshell/releases/latest)
[![MIT](https://img.shields.io/badge/license-MIT-176b52)](LICENSE)

</div>

OpenShell 将 SSH 终端、SFTP 文件管理、文件传输和 AI 辅助操作整合到一个 Windows 桌面应用中。无需在多个工具之间反复切换，就能连接服务器、管理会话、处理文件并完成日常运维工作。

## 产品预览

<p align="center">
  <img src="docs/screenshots/01-workspace-overview.png" alt="OpenShell 主工作空间" width="100%" />
</p>

<p align="center"><sub>SSH 会话、终端、SFTP 与 AI 助手集中在一个工作空间。</sub></p>

| SSH 多会话与分屏 | SFTP 文件管理 |
|:---:|:---:|
| ![SSH 多会话分屏](docs/screenshots/02-split-terminals.png) | ![SFTP 文件管理](docs/screenshots/04-sftp-file-manager.png) |
| **全局 AI 助手** | **Rust 原生 ZMODEM** |
| ![全局 AI 助手](docs/screenshots/03-ai-assistant.png) | ![原生 ZMODEM](docs/screenshots/05-native-zmodem-transfer.png) |

## 核心能力

### SSH 工作空间
- 多会话标签、会话树、拖拽排序与会话复制。
- 左右 / 上下分屏，同时操作多台服务器。
- 异常断线重连、输出搜索和本地终端。
- 支持密码与本地私钥认证，首次连接校验 SSH 主机指纹。

### SFTP 文件管理
- 本地与远程文件浏览，批量上传和下载。
- 传输队列、取消、重试与已验证前缀续传。
- 远程文本编辑、权限管理和单向目录同步预览。
- 根据终端上报的远程工作目录打开 SFTP。

### 原生文件传输
- Windows 使用 Rust 原生 ZMODEM 引擎处理 `rz` / `sz`。
- 支持多文件传输、进度展示与任务取消。
- 远端安装 `trzsz` 后可使用 `trz` / `tsz`。
- 无需安装 Windows 版 lrzsz，也无需额外配置 PATH。

### 可选 AI 助手
- 配置兼容的模型 API 与模型 ID。
- 全局 AI 助手可面向选定的 SSH 会话处理任务。
- 终端 AI 在当前 SSH 终端中协助操作。
- 支持 MySQL/MariaDB、Redis、PostgreSQL（`psql`）和 Python 等交互环境。
- AI 不属于 SSH / SFTP 的运行前提；不配置模型也可以正常使用核心功能。

### 会话管理与个性化
- 导入 Xshell `.xts` / `.xsh` 会话。
- 会话文件夹、快速命令、备份与恢复。
- 英文 / 简体中文，浅色 / 深色应用主题及独立终端配色。

## 下载与安装

前往 **[GitHub Releases](https://github.com/hctty27/openshell/releases/latest)** 下载最新 Windows x64 版本。

| 安装包 | 适用场景 |
|---|---|
| `OpenShell-vX.Y.Z-windows-x64-Setup.exe` | 推荐。正常安装并从开始菜单启动。 |
| `OpenShell-vX.Y.Z-windows-x64-portable.zip` | 便携使用。请完整解压，并保留应用旁边的 `zmodem` 目录。 |

需要 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。

> 请查看每个 Release 的说明，确认该版本实际的代码签名状态。不要假设所有版本均已签名。

## 快速开始

1. 下载并启动 OpenShell。
2. 新建 SSH 会话，填写主机、端口、用户名及认证信息。
3. 首次连接时核对服务器 SSH 主机指纹。
4. 连接后使用标签和分屏管理终端，或从终端工具栏打开 SFTP。
5. 如需 AI 功能，在「设置 → AI」中配置模型服务。

详细操作说明见 [README 使用说明与功能文档](README.zh-CN.md) 及 [项目文档目录](docs/)。

## 隐私与安全

- 会话、偏好设置和可信主机指纹保存在本地。
- 密码与私钥口令使用 Windows 凭据管理器保存。
- 私钥文件由用户自行保管，OpenShell 保存其路径。
- 只有主动使用 AI 功能时，请求内容和必要上下文才会发送到用户配置的模型服务。
- 首次连接验证 SSH 主机指纹；已信任指纹发生变化时会阻止连接。

相关政策与供应链信息：
[隐私政策](PRIVACY.md) · [代码签名政策](CODE_SIGNING_POLICY.md) · [第三方组件审查](docs/third-party-review.md) · [SBOM](docs/sbom.md)

## 项目状态与平台支持

- 当前正式交付平台：Windows x64。
- 提供安装版与便携版。
- 项目采用 MIT License。
- macOS / Linux 桌面版本暂未提供。
- ProxyJump / 跳板机、SSH agent 认证、云同步等能力暂未支持。

## 开发与构建

**技术栈：** Go · Wails v3 · React · TypeScript · xterm.js · SQLite · Rust。

Windows 开发环境需要 Go 1.26+、Node.js 22、npm 和 WebView2。

```powershell
git clone https://github.com/hctty27/openshell.git
cd openshell

go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0

cd frontend
npm ci
cd ..

wails3 dev
```

测试、Windows 构建及发布流程见 [Windows 发布工作流](.github/workflows/windows-release.yml) 和 [CI 工作流](.github/workflows/ci.yml)。

## 反馈与参与

遇到问题请提交 [GitHub Issue](https://github.com/hctty27/openshell/issues)，并尽量附上：
- OpenShell 版本与 Windows 版本。
- 可复现的操作步骤和预期 / 实际结果。
- 已脱敏的诊断日志。

涉及功能行为变更时，请同步维护中英文 README。

## 许可证

OpenShell 使用 [MIT License](LICENSE)。第三方依赖和随包组件遵循各自许可证，详见 [第三方组件审查](docs/third-party-review.md) 与 [SBOM](docs/sbom.md)。
