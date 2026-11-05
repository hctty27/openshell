<div align="center">
  <img src="build/openshell-icon.svg" alt="OpenShell" width="88" height="88" />
  <h1>OpenShell</h1>
  <p><strong>免费开源 Windows SSH/SFTP 客户端：多会话、分屏终端与文件传输。</strong></p>
  <p>
    <a href="https://github.com/hctty27/openshell/releases/latest"><img src="https://img.shields.io/github/v/release/hctty27/openshell?label=release" alt="最新版本" /></a>
    <a href="https://github.com/hctty27/openshell/actions/workflows/ci.yml"><img src="https://github.com/hctty27/openshell/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
    <a href="https://github.com/hctty27/openshell/releases/latest"><img src="https://img.shields.io/badge/platform-Windows%20x64-0078D4" alt="Windows x64" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT 许可证" /></a>
  </p>
  <p><a href="README.md">English</a> · <strong>简体中文</strong></p>
  <p>
    <a href="https://openshell.testnb.me/">官方网站</a> ·
    <a href="https://github.com/hctty27/openshell/releases/latest">下载</a> ·
    <a href="#快速开始">快速开始</a> ·
    <a href="CHANGELOG.md">更新记录</a> ·
    <a href="https://github.com/hctty27/openshell/issues">反馈问题</a>
  </p>
</div>

OpenShell 是面向开发者与服务器管理员的免费开源 Windows SSH/SFTP 客户端，支持多标签、分屏终端、会话管理、SFTP、rz/sz、Xshell 会话导入与快捷命令。

**项目状态：** 已进入 v1.0 正式版阶段，持续维护更新。已提供 Windows x64 安装版与便携版，各版本改动和实际签名状态见 [发布说明](https://github.com/hctty27/openshell/releases)。

**政策文件：** [Code signing policy（代码签名政策）](CODE_SIGNING_POLICY.md) · [隐私政策](PRIVACY.md) · [第三方组件授权审查](docs/third-party-review.md) · [SignPath 申请清单](docs/signpath-application-checklist.md)。

## 界面预览

**SSH 终端与 SFTP 文件管理**

![OpenShell SSH 终端与 SFTP 文件管理](docs/screenshots/02-ssh-sftp.webp)

## 为什么选择 OpenShell

- **熟悉的终端操作。** 集中管理 SSH 会话，自由调整标签顺序、使用分屏，并在断线后保持工作空间。
- **文件传输无需切换软件。** 内置 SFTP 文件管理器，同时支持 `rz` / `sz` 和 `trz` / `tsz`，统一使用内嵌文件选择器与传输进度中心。
- **轻量、专注的 SSH 工具。** 无须配置 AI 服务，连接、终端与文件管理均可直接使用。

## 功能亮点

| 功能 | 可以做什么 |
| --- | --- |
| SSH 工作空间 | 多标签、复制连接、拖拽排序、左右或上下分屏及输出搜索，支持 vim、top 等交互式程序。 |
| 会话管理 | 多级文件夹、搜索与编辑会话、密码与本地私钥认证、Xshell 会话导入、会话备份与恢复。 |
| 连接控制 | 支持 SSH 保活、异常重连、主动断开、断线返回本地终端，关闭活动连接或退出应用前进行确认。 |
| SFTP 文件管理 | 浏览本地与远程文件，上传下载文件和目录、断点续传、远程文本编辑、单向目录同步预览、权限管理。 |
| 终端文件传输 | 支持 `rz` / `sz` 与 `trz` / `tsz`，统一使用内嵌文件选择器与顶部传输中心，无需弹出系统资源管理器或额外 CMD 窗口。 |
| 快速命令 | 支持搜索、排序及全局 / 文件夹 / 会话作用范围，通过换行控制是否执行。 |
| 外观与语言 | 英文与简体中文切换，浅色 / 深色应用主题，独立的经典黑色、深灰和白色终端配色。 |

## 下载安装

前往 **[GitHub Releases](https://github.com/hctty27/openshell/releases/latest)** 下载最新版本。

| 安装包 | 使用方式 |
| --- | --- |
| `OpenShell-vX.Y.Z-windows-x64-Setup.exe` | Windows 安装版，运行安装程序即可。 |
| `OpenShell-vX.Y.Z-windows-x64-portable.zip` | 完整解压后运行 `OpenShell-vX.Y.Z.exe`，保留旁边的 `zmodem` 目录。 |

应用依赖 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。本地终端回退使用 Windows ConPTY；选择 PowerShell 7 或 WSL 时，需要先安装对应环境。

便携版免安装，但配置和凭据仍保存在 Windows 用户目录与凭据管理器中。

## 快速开始

1. **添加会话。** 填写主机、端口、用户名及密码或私钥信息。单击会话查看详情，双击连接服务器。
2. **核对服务器。** 首次连接时核对 SSH 主机指纹，确认后信任；已信任的指纹变化时会阻止连接。
3. **选择工作方式。** 使用多标签与分屏操作终端，或点击终端工具栏中的 SFTP 入口管理文件。
4. **调整偏好。** 设置中的「通用」管理语言与应用外观，「终端」管理终端选项，「连接」管理保活、重连及断开行为。

界面默认英文，可在「Settings → General」切换为简体中文。已经连接的会话也可以编辑：名称和分组立即同步，主机、端口、用户名与认证配置在下次连接时生效。

### 终端常用操作

- 双击已连接标签，以相同名称新开独立连接；拖拽标签可调整顺序，也可使用 Alt+Shift+左右方向键。顶部 `+` 打开会话选择窗口。
- 连接两个会话后选择分屏对象，可切换左右 / 上下布局，并拖动分隔线调整比例。
- 可在设置中启用「选中自动复制」「鼠标右键粘贴」及多行粘贴确认。
- 终端配色支持全局设置与单会话覆盖，无需重连即可生效；快速命令栏可选择单行横向滚动或多行布局。
- 断开后可返回本地终端、保留已断开的标签或自动关闭标签。本地 Shell 支持 Windows PowerShell、PowerShell 7、CMD、WSL。自动重连只针对异常断线，主动断开不会自动连接。关闭活动 SSH 标签或退出仍有连接的应用时需要确认。
- 点击快速命令栏的「管理」添加命令。每个换行对应一次 Enter；末尾不换行，最后一行只输入、不执行。使用前请确认终端处于可接收 Shell 命令的状态。

## 文件管理与传输

### SFTP

在已连接的 SSH 标签中打开文件管理器，复用当前认证连接。支持本地 / 远程浏览、拖拽上传下载、任务队列、取消、重试及校验已传输内容前缀后的断点续传。

- **远程编辑：** 支持不超过 1 MiB 的 UTF-8 文本，保存前校验远程文件版本。
- **目录同步：** 预览本地到远程或远程到本地的单向变更，根据大小和修改时间判断差异，跳过较新的目标文件；当前同步流程不删除文件。
- **权限管理：** 最多对 200 个选中项批量修改权限，执行前确认。

### 打开 SFTP 时跟随终端目录

OpenShell 支持通过 **OSC 7**、**OSC 1337** 及 **OSC 0/2 终端标题**（如 `user@host:/path`）识别工作目录。远程 Shell 已有目录上报时无需额外配置；否则使用已知的初始目录，上报路径不可访问时回退到 SFTP 默认目录。不会向正在运行的交互程序注入隐藏的 `pwd` 命令。

<details>
<summary>为远程 Bash 开启目录上报</summary>

将以下内容添加一次到远程服务器的 `~/.bashrc`。它会保留已有 `PROMPT_COMMAND`，并转义路径中影响 URI 解析的字符。

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

重新连接后生效。每次显示新提示符都会报告当前目录，执行 `cd /some/path` 后打开 SFTP 即可使用该路径。

</details>

### ZMODEM：`rz` / `sz`

在远程终端运行 `rz`，选择本地文件上传；运行 `sz /path/to/file`，选择本地下载位置。远程服务器需要安装 `lrzsz`。官方 Windows 包已内置 `rz/sz` 的无控制台窗口启动器，原版工具与 `msys-2.0.dll` 存放于 `zmodem/native/`，并附许可证和源码，无需配置 Windows PATH。

OpenShell 精简内嵌文件选择器可直接选择上传文件或下载目录，不会弹出 Windows 资源管理器。进度集中显示在工作区顶部的非模态传输中心，A 会话传输时仍可切换 B 会话继续操作；可通过传输中心或 Ctrl+C 取消。内置启动器不会额外弹出 CMD 窗口，下载遇到同名文件时使用 `rz -E` 重命名策略。协议数据在进入终端历史与 AI 上下文前过滤。ZMODEM 在 tmux/screen 中可能不稳定；目录与断点续传请使用 SFTP。

### 原生 trzsz：`trz` / `tsz`

远程服务器安装 `trzsz` 后，可以使用 `trz` 上传和 `tsz file` 下载；`trz -d` 支持从内嵌选择器选择文件夹上传。两套协议共用精简文件选择器和顶部传输中心。原生 trzsz 展示单文件百分比；传统 `rz` / `sz` 无法可靠获取总大小时使用动态进度条。各 SSH 会话传输状态相互独立，切换会话不会中断原传输。

## 会话导入与备份

| 来源 | 保留内容 | 需要重新配置 |
| --- | --- | --- |
| Xshell `.xts` / `.xsh` | SSH 连接配置和文件夹结构，支持 UTF-16 / UTF-8；可预览、勾选，重名时跳过或自动重命名。 | 密码与私钥认证。不导入 Xshell 加密凭据、Telnet、代理及跳板机配置。 |
| OpenShell JSON 备份 | 已保存的 SSH 会话和多级文件夹，在「设置 → 通用 → 会话备份」中导出与恢复。 | 凭据及私钥文件。会话备份不包含 Windows 凭据和外观偏好。 |

从 Xshell 迁移时，先导出会话，再点击 OpenShell 会话面板中的「导入 Xshell」，核对导入预览，重新填写认证信息后连接。

## 本地数据与隐私

| 数据 | 保存位置 |
| --- | --- |
| 会话、文件夹、偏好及可信主机指纹 | `%APPDATA%\OpenShell\state.db` |
| 密码与私钥口令 | Windows 凭据管理器中的 OpenShell 项。 |
| 私钥 | 用户选择的原文件，OpenShell 仅保存路径。 |

OpenShell 仅按用户操作连接到配置的 SSH/SFTP 服务器。旧版 AI 配置与对话记录可能仍保留在升级前的本地数据库中，本版本不会自动删除，以避免数据丢失。

## 本地开发

**技术栈：** Go · Wails v3.1.0 · React · TypeScript · xterm.js · SQLite。

请使用 Windows 开发环境，并准备 Go 1.26+、满足锁定 Vite 版本要求的较新 Node.js 22、npm 和 WebView2。依赖版本见 [go.mod](go.mod) 与 [frontend/package-lock.json](frontend/package-lock.json)。

```sh
git clone https://github.com/hctty27/openshell.git
cd openshell
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0
cd frontend
npm ci
cd ..
wails3 dev
```

构建 Windows x64 可执行文件：

```sh
wails3 generate bindings -names -ts
wails3 generate syso -manifest build/windows/wails.exe.manifest -icon build/windows/icon.ico -info build/windows/info.json -arch amd64 -out rsrc_windows_amd64.syso
go build -tags production -trimpath -ldflags="-H windowsgui -s -w" -o build/bin/OpenShell.exe .
```

产物为 `build/bin/OpenShell.exe`，构建前需要生成 `build/windows/icon.ico`。以上命令不打包 ZMODEM 工具；需要时在构建后通过 PowerShell 运行 [scripts/prepare_zmodem_windows.ps1](scripts/prepare_zmodem_windows.ps1)。完整图标生成、安装版与便携版打包流程见 [Windows 发布工作流](.github/workflows/windows-release.yml)。

<details>
<summary>验证与发布流程</summary>

从仓库根目录执行：

```sh
go test -race ./...
go vet ./...
cd frontend
npm test -- --run
npm run build
npx playwright install chromium
npx playwright test
```

后端测试使用可控 SSH 服务与模拟 API。浏览器测试使用模拟 Wails 桥接，不能替代 Windows 原生验收。

- [CI](.github/workflows/ci.yml)：PR 和 `main` 推送运行 Go race 检测、`go vet`、前端测试、生产构建及选定的 Chromium 回归。
- [Windows terminal smoke](.github/workflows/windows-terminal-smoke.yml)：对终端、SSH、SFTP、ConPTY 相关 PR 执行 Windows 冒烟验证。
- [Windows release](.github/workflows/windows-release.yml)：只有 `main` 的版本标记变化且 CI 通过后才正式发布。保留最近 3 个 Release 及 v1.0.0 等大版本里程碑，旧 Git Tag 不删除，最终构建产物保留 7 天。手动运行仅生成 Artifacts，不发布 Release。

**推荐一键发布：** 打开 GitHub Actions 中的 [Publish OpenShell (one click)](.github/workflows/publish.yml)，选择 `main` 分支，默认 `patch`（也可选 `minor` / `major`），点击 **Run workflow**。工作流自动同步版本标记、npm 版本文件、Windows 版本信息和更新日志，提交版本变更，并在固定提交上执行 Go / 前端验证；Windows 构建复用已验证的前端产物，最后发布安装包和便携 ZIP。若版本已准备好但打包失败，再次运行将继续发布该版本，不会重复升级版本号。请勿同时运行多个发布流程。

**兼容原有方式：** 仍可手动同步 `.github/release-version.txt`、`frontend/package.json`、`frontend/package-lock.json`、`CHANGELOG.md`，合并到 `main` 后沿用版本标记触发的 CI 发布。

</details>

## 项目说明

- 当前交付 Windows x64 桌面应用，暂未提供 macOS / Linux 桌面安装包。
- 暂不支持 ProxyJump / 跳板机、SSH agent 认证、云同步及快速命令参数占位符。
- Windows 原生输入法、剪贴板、凭据存储、异常传输和性能仍需实机验证；工具调用兼容性取决于具体 API 服务商及模型。
- 终端上下文附件限制为 200 行 / 32 KiB。如果旧终端历史已经被裁剪，预览可能缺少截断提示。

实现细节与验证范围见 [Windows 验收记录](docs/windows-acceptance.md)、[稳定性验收](docs/stability-acceptance.md) 与 [多语言说明](docs/internationalization.md)。

欢迎提交问题和范围明确的 PR。反馈 [Issue](https://github.com/hctty27/openshell/issues) 时，请附上 OpenShell 版本、Windows 版本、复现步骤及脱敏日志。修改文档中的功能行为时，请同步维护中英文 README。

## 许可证与代码签名

OpenShell 使用 **[MIT 许可证](LICENSE)**。随包分发的第三方组件遵循各自许可证，Windows ZMODEM 工具附带 GPL 声明与对应源码包。

免费代码签名由 [SignPath.io](https://about.signpath.io/) 提供，证书由 [SignPath Foundation](https://signpath.org/) 提供。 仅在申请获批且签名功能实际启用后适用；当前发布的 **v1.0.0 Windows 安装包和便携版仍未签名**，不代表已获 SignPath 认证。

签名仅在所需 SignPath 配置和密钥齐全时启用，否则构建产物不带签名；以每个 Release 的实际说明为准。应用可执行文件与安装程序由 GitHub Actions 构建，便携 ZIP 包含应用可执行文件。仅将本仓库源码构建的产物提交签名。

**提交者、审核者及签名审批者：** [hctty27](https://github.com/hctty27)。
