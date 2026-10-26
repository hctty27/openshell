<div align="center">
  <img src="build/openshell-icon.svg" alt="OpenShell" width="88" height="88" />
  <h1>OpenShell</h1>
  <p><strong>Windows 轻量 AI SSH 工作空间：终端、SFTP 文件传输与可控远程命令执行。</strong></p>
  <p>
    <a href="https://github.com/hctty27/openshell/releases/latest"><img src="https://img.shields.io/github/v/release/hctty27/openshell?label=release" alt="最新版本" /></a>
    <a href="https://github.com/hctty27/openshell/actions/workflows/ci.yml"><img src="https://github.com/hctty27/openshell/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
    <a href="https://github.com/hctty27/openshell/releases/latest"><img src="https://img.shields.io/badge/platform-Windows%20x64-0078D4" alt="Windows x64" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT 许可证" /></a>
  </p>
  <p><a href="README.md">English</a> · <strong>简体中文</strong></p>
  <p>
    <a href="https://github.com/hctty27/openshell/releases/latest">下载</a> ·
    <a href="#快速开始">快速开始</a> ·
    <a href="CHANGELOG.md">更新记录</a> ·
    <a href="https://github.com/hctty27/openshell/issues">反馈问题</a>
  </p>
</div>

OpenShell 是面向开发者与服务器管理员的轻量 Windows SSH/SFTP 客户端。它将多标签与分屏终端、文件传输和 AI 远程协助整合到一个工作空间；支持自定义模型和 API，并可选择命令确认执行或受控自动执行。

**项目状态：** 正在积极开发，尚未达到 1.0 正式版。已提供 Windows x64 安装版与便携版，各版本改动和实际签名状态见 [发布说明](https://github.com/hctty27/openshell/releases)。

## 为什么选择 OpenShell

- **熟悉的终端操作。** 集中管理 SSH 会话，自由调整标签顺序、使用分屏，并在断线后保持工作空间。
- **文件传输无需切换软件。** 内置 SFTP 文件管理器，也支持通过 `rz` / `sz` 在应用内选取文件、查看进度。
- **AI 模型与执行权限由你控制。** 支持 OpenAI 兼容接口和 Anthropic 原生 Messages API，可自由选择普通对话、确认执行或受控自动执行；SSH/SFTP 无需配置 AI。

## 功能亮点

| 功能 | 可以做什么 |
| --- | --- |
| SSH 工作空间 | 多标签、复制连接、拖拽排序、左右或上下分屏及输出搜索，支持 vim、top 等交互式程序。 |
| 会话管理 | 多级文件夹、搜索与编辑会话、密码与本地私钥认证、Xshell 会话导入、会话备份与恢复。 |
| 连接控制 | 支持 SSH 保活、异常重连、主动断开、断线返回本地终端，关闭活动连接或退出应用前进行确认。 |
| SFTP 文件管理 | 浏览本地与远程文件，上传下载文件和目录、断点续传、远程文本编辑、单向目录同步预览、权限管理。 |
| 终端文件传输 | 支持 `rz` / `sz` 和内置 ZMODEM 工具，通过应用内文件选择器与进度弹窗完成传输，无需弹出资源管理器或额外 CMD 窗口。 |
| AI 助手 | 支持 OpenAI 兼容接口与 Anthropic 原生 Messages API、流式对话、确认执行和自动执行命令，同一服务器的标签共享对话历史。 |
| 快速命令 | 支持分类、排序及全局 / 文件夹 / 会话作用范围，通过换行控制是否执行。 |
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
5. **按需配置 AI。** 在「AI 配置」中添加 API 配置，测试连接后保存，再在 AI 侧边栏选择模型配置和执行模式。

界面默认英文，可在「Settings → General」切换为简体中文。SSH 和 SFTP 无需配置 AI API Key。已经连接的会话也可以编辑：名称和分组立即同步，主机、端口、用户名与认证配置在下次连接时生效。

### 终端常用操作

- 双击已连接标签，以相同名称新开独立连接；拖拽标签可调整顺序，也可使用 Alt+Shift+左右方向键。顶部 `+` 打开会话选择窗口。
- 连接两个会话后选择分屏对象，可切换左右 / 上下布局，并拖动分隔线调整比例。
- 可在设置中启用「选中自动复制」「鼠标右键粘贴」及多行粘贴确认。
- 终端配色支持全局设置与单会话覆盖，无需重连即可生效；快速命令栏可选择单行横向滚动或多行布局。
- 断开后可返回本地终端、保留已断开的标签或自动关闭标签。本地 Shell 支持 Windows PowerShell、PowerShell 7、CMD、WSL。自动重连只针对异常断线，主动断开不会自动连接。关闭活动 SSH 标签或退出仍有连接的应用时需要确认。
- 点击快速命令栏的「管理」添加命令。每个换行对应一次 Enter；末尾不换行，最后一行只输入、不执行。使用前请确认终端处于可接收 Shell 命令的状态。

## AI 助手

### 配置自己的接口

| 配置项 | 填写内容 |
| --- | --- |
| API 协议 | 选择 **OpenAI 兼容接口**（旧配置默认）或 **Anthropic 原生 Messages API**。 |
| Base URL | Chat Completions 兼容接口示例：`https://api.example.com/v1`；Anthropic 原生接口示例：`https://api.anthropic.com/v1`。 |
| API Key | 服务商分配的密钥；本机无需认证的服务可以留空。 |
| 模型名称 | 服务商支持的准确模型 ID。 |
| 工具调用 | 仅在接口和模型都支持时启用；AI 执行命令需要此能力。 |

远程接口必须使用 HTTPS；本机回环地址（如 `127.0.0.1`、`::1`）可以使用 HTTP。Anthropic Messages 使用原生 SSE 和 `x-api-key` 认证，已有配置保持 OpenAI Chat Completions 行为。OpenAI Responses API 暂未直接支持。Anthropic 原生协议已覆盖模拟测试，但真实 API 凭据及工具调用仍需实机验收。

### 选择命令执行方式

| 模式 | 行为 |
| --- | --- |
| 普通对话 | 讨论问题，不执行命令。 |
| 确认执行 | 检查目标服务器、工作目录和命令后确认执行，也可以修改或拒绝命令。 |
| 自动执行 | AI 连续执行命令并分析结果。默认仅自动放行能识别的检查命令；修改、无法识别及重复命令需要确认。 |

自动执行默认**每轮最多 10 条命令**，可设置为 1–100 条；达到上限后需手动继续下一轮。设置中还可为新任务开启「允许修改操作」。任务固定使用启动时的服务器连接、API 配置和执行限制，断线、重连或执行结果未知时停止。

**AI 命令使用独立的 SSH exec 通道。** 不继承手动终端中的 `cd`、临时环境变量、虚拟环境或 sudo 状态。执行前请检查远程绝对工作目录，默认使用远程 HOME。快速命令则直接输入当前交互式终端，沿用该 Shell 的状态。

执行结果包含 stdout、stderr、退出码和耗时。默认超时 60 秒，可调整为 1–600 秒。停止或超时会取消等待并阻止后续动作，但不保证远程进程已经退出；通道建立无响应时可能需要断开 SSH。密码输入和其他交互式命令请在手动终端完成。聊天回复中的 Markdown 代码块不会自动执行。

### 对话记忆与上下文

- 每个已保存的服务器会话可以拥有多条 AI 对话。同一会话的多个标签共享对话列表，可以分别选择；查看同一条对话时消息同步。
- 新对话在首次发送消息前保持草稿，不产生空历史记录。历史与摘要默认保存到本地，也可以在 AI 设置中关闭。
- 只有发起请求的标签能控制该请求的命令。恢复历史或重连不会恢复待执行命令与自动任务；清空或删除对话会影响所有正在查看它的标签。
- 关闭历史保存后使用临时对话，已有历史仍保留。重新开启后恢复已有历史，不补存临时消息。切换前需要停止正在运行的任务。
- 长对话采用摘要与近期轮次，受 **48 KiB 请求数据预算**限制，并非精确 Token 上限。摘要使用当前模型，可能产生额外接口费用；摘要失败时回退到有限的近期上下文。
- 终端选区或近期输出在预览、确认后才附加给 AI；AI 执行命令的结果也会返回给模型。发送前请检查内容，自动遮盖无法识别所有敏感信息。

## 文件管理与传输

### SFTP

在已连接的 SSH 标签中打开文件管理器，复用当前认证连接。支持本地 / 远程浏览、拖拽上传下载、任务队列、取消、重试及校验已传输内容前缀后的断点续传。

- **远程编辑：** 支持不超过 1 MiB 的 UTF-8 文本，保存前校验远程文件版本。
- **目录同步：** 预览本地到远程或远程到本地的单向变更，根据大小和修改时间判断差异，跳过较新的目标文件；当前同步流程不删除文件。
- **权限管理：** 最多对 200 个选中项批量修改权限，执行前确认。
- **AI 文件助手：** 按需分析选中的配置文件、有限长度日志或文件差异。建议修改需在编辑器中审查后保存，上传建议也需要确认。

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

OpenShell 内嵌文件选择器可直接选择上传文件或下载目录，不会弹出 Windows 资源管理器。传输进度在应用内弹窗展示，完成后自动收起；可通过传输控件或 Ctrl+C 取消。内置启动器不会额外弹出 CMD 窗口，下载遇到同名文件时使用 `rz -E` 重命名策略。协议数据在进入终端历史与 AI 上下文前过滤。ZMODEM 在 tmux/screen 中可能不稳定；目录与断点续传请使用 SFTP。

## 会话导入与备份

| 来源 | 保留内容 | 需要重新配置 |
| --- | --- | --- |
| Xshell `.xts` / `.xsh` | SSH 连接配置和文件夹结构，支持 UTF-16 / UTF-8；可预览、勾选，重名时跳过或自动重命名。 | 密码与私钥认证。不导入 Xshell 加密凭据、Telnet、代理及跳板机配置。 |
| OpenShell JSON 备份 | 已保存的 SSH 会话和多级文件夹，在「设置 → 通用 → 会话备份」中导出与恢复。 | 凭据及私钥文件。会话备份不包含 AI 配置、API Key、外观偏好和对话历史。 |

从 Xshell 迁移时，先导出会话，再点击 OpenShell 会话面板中的「导入 Xshell」，核对导入预览，重新填写认证信息后连接。

## 本地数据与隐私

| 数据 | 保存位置 |
| --- | --- |
| 会话、文件夹、API 配置、偏好及可信主机指纹 | `%APPDATA%\OpenShell\state.db` |
| 已保存的 AI 对话与摘要 | 同一个本地数据库，可关闭历史保存。 |
| 密码、API Key、私钥口令 | Windows 凭据管理器中的 OpenShell 项。 |
| 私钥 | 用户选择的原文件，OpenShell 仅保存路径。 |

SSH / SFTP 与 AI 连接使用你配置的地址。发送给 AI 服务商的提示词、附加片段及 AI 命令结果受该服务商的数据政策约束。除用户、安装者或操作者明确请求的操作外，程序不会向其他网络系统传输信息。

## 本地开发

**技术栈：** Go · Wails v2 · React · TypeScript · xterm.js · SQLite。

请使用 Windows 开发环境，并准备 Go 1.26+、满足锁定 Vite 版本要求的较新 Node.js 22、npm 和 WebView2。依赖版本见 [go.mod](go.mod) 与 [frontend/package-lock.json](frontend/package-lock.json)。

```sh
git clone https://github.com/hctty27/openshell.git
cd openshell
go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.0
cd frontend
npm ci
cd ..
wails dev
```

构建 Windows x64 可执行文件：

```sh
wails build -platform windows/amd64 -clean
```

产物为 `build/bin/OpenShell.exe`。单独执行 Wails 构建不会打包 ZMODEM 工具；需要时在构建后通过 PowerShell 运行 [scripts/prepare_zmodem_windows.ps1](scripts/prepare_zmodem_windows.ps1)。完整图标生成、安装版与便携版打包流程见 [Windows 发布工作流](.github/workflows/windows-release.yml)。

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
- [Windows release](.github/workflows/windows-release.yml)：只有 `main` 的版本标记变化且 CI 通过后才正式发布。保留最近 3 个 Release 和旧 Git Tag，最终构建产物保留 7 天。手动运行仅生成 Artifacts，不发布 Release。

发布时同步更新 `.github/release-version.txt`、`frontend/package.json`、`frontend/package-lock.json`、`frontend/src/App.tsx` 的回退版本、`wails.json` 及 `CHANGELOG.md`。推送到 `main` 后，工作流在验证与打包通过后自动创建 Tag。

</details>

## 项目说明

- 当前交付 Windows x64 桌面应用，暂未提供 macOS / Linux 桌面安装包。
- 暂不支持 ProxyJump / 跳板机、SSH agent 认证、云同步及快速命令参数占位符。
- Windows 原生输入法、剪贴板、凭据存储、异常传输和性能仍需实机验证；工具调用兼容性取决于具体 API 服务商及模型。
- 终端上下文附件限制为 200 行 / 32 KiB。如果旧终端历史已经被裁剪，预览可能缺少截断提示。

实现细节与验证范围见 [Windows 验收记录](docs/windows-acceptance.md)、[稳定性验收](docs/stability-acceptance.md)、[对话记忆验证](docs/conversation-memory-validation.md) 与 [多语言说明](docs/internationalization.md)。

欢迎提交问题和范围明确的 PR。反馈 [Issue](https://github.com/hctty27/openshell/issues) 时，请附上 OpenShell 版本、Windows 版本、复现步骤及脱敏日志。修改文档中的功能行为时，请同步维护中英文 README。

## 许可证与代码签名

OpenShell 使用 **[MIT 许可证](LICENSE)**。随包分发的第三方组件遵循各自许可证，Windows ZMODEM 工具附带 GPL 声明与对应源码包。

免费代码签名由 [SignPath.io](https://about.signpath.io/) 提供，证书由 [SignPath Foundation](https://signpath.org/) 提供。

签名仅在所需 SignPath 配置和密钥齐全时启用，否则构建产物不带签名；以每个 Release 的实际说明为准。应用可执行文件与安装程序由 GitHub Actions 构建，便携 ZIP 包含应用可执行文件。仅将本仓库源码构建的产物提交签名。

**提交者、审核者及签名审批者：** [hctty27](https://github.com/hctty27)。
