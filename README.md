# OpenShell

<img src="build/openshell-icon.svg" alt="OpenShell 应用图标" width="88" height="88" />

轻量的 Windows SSH 客户端，集成会话管理、多标签终端和可自定义 API 的 AI 助手。

**图标：** 极简终端 + AI 星芒；`build/openshell-icon.svg` 为可编辑矢量源稿，`build/appicon.png` 为多尺寸 ICO 的 PNG 来源；Windows 构建使用 `python scripts/generate_app_icons.py`（需 Pillow）。

**项目地址：** https://github.com/hctty27/openshell

**当前版本：** [GitHub Releases](https://github.com/hctty27/openshell/releases/latest)（测试版）

支持浅色/深色主题：设置 → 外观 → 主题，点击“保存外观”后重启保留。终端采用固定 6px 细滚动条，并修复末行裁切。

## 功能

- **会话管理**：Xshell 风格的多级树形分组、Xshell `.xts`/`.xsh` 会话导入、OpenShell 会话备份和恢复、搜索、下方只读会话详情（管理菜单仍可编辑）、密码和本地私钥认证。
- **SSH 终端**：多标签、UTF-8、256 色、窗口尺寸同步、字体调整，支持 vim/top 和交互式 sudo。支持在设置中开启选中自动复制、右键粘贴和多行粘贴确认。
- **快速命令栏**：终端下方固定「管理」按钮，后接自定义命令；单行模式高度为 30px，横向滚动；多行模式按内容扩展。支持分类、排序、全局/分组/会话作用范围及执行前确认。
- **AI 助手**：流式对话、终端日志预览、每标签独立上下文。
- **自定义 API**：Base URL、API Key、模型 ID、多配置，兼容 OpenAI Chat Completions。
- **命令执行**：AI 提议命令，用户确认后执行，回传 stdout、stderr、退出码和耗时；支持拒绝、修改、超时和取消。
- **本地凭据**：Windows 凭据管理器保存密码、私钥口令与 API Key。

## 使用

1. 从 [Releases](https://github.com/hctty27/openshell/releases) 下载 Windows x64 的安装版（Setup.exe）或便携版（ZIP）。便携版解压后运行 **OpenShell-vX.Y.Z.exe**（实际文件名中的 X.Y.Z 为下载版本号，以减少 Windows Explorer 旧图标缓存的影响）。
2. 新建会话，填写主机、端口、用户名和认证信息；单击会话在左下方查看详情，双击连接。
3. 首次连接时核对服务器指纹，确认后继续。
4. 设置 → AI API：填写接口地址、密钥和准确的模型 ID，测试连接后保存。
5. 右侧选择配置，使用“操作模式”描述任务，检查目标服务器、工作目录和命令后点击“确认执行”。
6. SSH 标签下方点击「管理」添加快速命令；设置 → 外观 → 快速命令栏布局，可以在单行横向滚动与多行之间切换。

应用依赖 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。

### API 配置示例

| 字段 | 示例 |
| --- | --- |
| Base URL | `https://api.example.com/v1` |
| API Key | 接口提供方分配的密钥；本机无鉴权服务可留空 |
| 模型名称 | 接口提供的模型 ID |
| 工具调用 | 模型和接口均支持时开启 |

远程接口使用 HTTPS；本机接口支持 `http://127.0.0.1:端口/v1` 或 IPv6 loopback。暂不支持 Anthropic 原生 Messages 或 OpenAI Responses，需要使用 Chat Completions 兼容接口。

工具调用关闭时可使用普通对话；不会自动运行模型回复中的 Markdown 代码块。

### 从 Xshell 迁移会话

1. 在 Xshell 菜单中导出会话（`.xts`），也可以选择单个 `.xsh` 文件。
2. 在 OpenShell 左侧「会话」标题栏点击「导入 Xshell」，选择文件。
3. 勾选要导入的 SSH 会话，选择同名冲突处理（跳过或自动重命名），确认导入。
4. 在会话列表中核对服务器主机、端口和用户名；重新录入密码或 OpenSSH 私钥后连接。

支持 UTF-16（Xshell 6+）与 UTF-8 会话文件。只导入 SSH 配置，不导入 Telnet、代理/跳板配置及 Xshell 专用凭据；不支持以 Xshell 加密口令恢复密码。ZIP 压缩包有条目数、文件大小和路径安全校验。导入操作以事务提交，失败时不会留下半批会话。

在「设置 → 通用 → 会话备份」可以导出、恢复 OpenShell 原生 JSON 会话备份，保留多级文件夹路径。**这仅包含 SSH 会话和文件夹，暂不备份 AI API 配置、偏好设置、私钥文件或 Windows 凭据**。迁移后需重新配置认证信息。恢复可选择跳过同名会话或为导入会话重命名，默认不会覆盖现有会话。

### SFTP 跟随当前终端目录

打开 SFTP 时优先使用当前 SSH 标签已知的工作目录。OpenShell 支持终端程序使用 **OSC 7**（`file://` URI）或
**OSC 1337;CurrentDir=** 上报目录；未收到上报时回退到连接初始工作目录。
如果你的远程 Bash 尚未主动报告目录，可以在其 `~/.bashrc` 中追加（**保留现有 PROMPT_COMMAND**）：

```bash
__openshell_report_cwd() { printf '\033]7;file://%s%s\007' "${HOSTNAME:-localhost}" "$PWD"; }
if declare -p PROMPT_COMMAND 2>/dev/null | grep -q 'declare -a'; then
  PROMPT_COMMAND+=(__openshell_report_cwd)
else
  PROMPT_COMMAND="__openshell_report_cwd${PROMPT_COMMAND:+;${PROMPT_COMMAND}}"
fi
```

重新登录或重新加载 shell 配置后，`cd /some/path` 将随提示符更新终端目录；再次打开 SFTP 就会进入该目录。
该机制只使用 shell 自愿发出的目录元数据，**不会向正在运行的 SSH 终端偷偷输入 `pwd`**。
不支持此类上报的 shell 将使用已知目录；目录被删除或不可访问时则回退到 SFTP 默认目录。

### ZMODEM 文件传输（rz/sz）

在已连接的 SSH 终端执行 `rz` 可选择本地文件上传，执行 `sz /path/to/file` 可选择本地目录接收。
OpenShell 在 Go 层过滤协议帧，不会将传输主体写入终端历史或发送给 AI。
文件选择使用本地系统对话框，传输提示在当前终端内展示。

**Windows 开箱即用：** 安装版和便携版包含已验证的 `rz.exe`、`sz.exe`、`msys-2.0.dll`、
GPL 许可证与对应源码包，无需配置 Windows 系统 PATH。远端服务器仍须安装 `lrzsz`。
下载已有同名文件时使用 `rz -E` 重命名策略，避免直接覆盖。传输中可点击取消或按 Ctrl+C，
传输状态和速度估计仍以过滤器报告为准。真正的 Windows GUI 大文件、批量以及异常中断场景仍需实机验收。

ZMODEM 和 SFTP 相互独立：交互终端的 `rz/sz` 使用 ZMODEM；普通文件浏览、目录同步与断点续传仍使用 SFTP。
ZMODEM 在 tmux/screen 中可能不稳定；目录传输请继续使用 SFTP。取消、覆盖冲突和统一传输管理将在后续阶段增强。

## 执行方式

AI 命令通过当前已认证的 SSH 连接直接在远程服务器执行，不需要再次运行 `ssh user@host`。

快速命令与 AI 命令的执行方式不同：快速命令会写入当前交互式终端（PTY），因此使用当前 shell 的目录和环境变量。编辑快速命令时，换行相当于按下 Enter，末尾没有换行则最后一行只输入、不执行。旧版保存的「发送并执行」命令会自动保留执行效果。请确保终端处于 shell 提示符状态；若当前正在使用 vim/top、正在输入密码或运行其他交互式程序，快捷输入可能被该程序接收。

每次使用独立 exec 通道，不继承手动终端里的 `cd`、临时环境变量、虚拟环境或 sudo 身份。执行前可检查并修改远程绝对工作目录；默认使用远程 HOME。

- **普通对话**：只聊天，不执行命令。
- **确认执行**：AI 提出命令，你确认后执行。
- **自动执行**：AI 逐条执行命令并读取结果，直到完成、暂停或停止。默认只自动执行能明确识别的检查命令；修改、无法识别和重复命令需要确认。
- 自动执行默认每轮最多 10 条。设置 → 自动执行可改为 1–100 条，并选择是否允许修改操作。达到上限时显示本轮与累计数量，点击“继续下一轮”才继续；每次实际提交的命令计一次，包括执行失败。
- 自动任务固定启动时的服务器连接、API 配置、上限和执行范围；设置更改只作用于新任务。每标签选择模式，重启后默认确认执行。
- 点击“停止任务”会取消当前请求并阻止后续命令；远端已经启动的进程不保证立即退出。断线、重连或执行结果无法确认时自动停止。
- 默认超时 60 秒，执行前可设为 1–600 秒。
- 需要输入密码的 sudo 和交互命令在手动终端完成。
- 超时或取消不保证远程进程已退出；无法取得退出码时显示“结果未知”。
- SSH 通道建立或启动确认无响应时，取消/超时可能断开整个 SSH 连接，需要重连。
- 编辑会话连接信息前先关闭对应标签，避免显示目标和实际连接不一致。
- 选中日志或近期输出经预览确认后才附加到 AI 请求；常见秘密遮盖不能代替人工检查。

## 本地数据

| 内容 | 位置 |
| --- | --- |
| 会话、分组、API 配置、偏好和主机指纹 | `%APPDATA%\OpenShell\state.db` |
| 密码、API Key、私钥口令 | Windows 凭据管理器中的 `OpenShell` 项 |
| 私钥 | 保留用户选择的原文件，配置仅保存路径 |
| AI 对话 | 仅内存保存，关闭标签或退出应用后清除 |

本项目使用独立的 OpenShell 配置和凭据命名空间。首次运行需要添加会话与 API 设置。

## 开发

技术栈：Go + Wails v2 + React + TypeScript + xterm.js + SQLite。

要求 Go 1.26+、Node.js 22 LTS 或其他满足 Vite 要求的版本、npm，以及 Windows 开发环境。依赖版本见 `go.mod` 和前端锁文件。

```sh
git clone https://github.com/hctty27/openshell.git
cd openshell
go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.0
cd frontend
npm ci
cd ..
wails dev
```

构建 Windows x64：

```sh
wails build -platform windows/amd64 -clean
```

产物：`build/bin/OpenShell.exe`。仓库现在使用两条 Actions 工作流：

- [CI](.github/workflows/ci.yml)：PR 与 `main` 推送均执行 Go、前端单元测试与 Chromium 回归；当且仅当 `main` 的版本标记变更且本次 CI 全部通过，才调用 Windows 正式发布。
- [Build and release Windows](.github/workflows/windows-release.yml)：复用 CI 结果，Windows 只构建前端及 Wails EXE、制作和校验安装包/便携包，自动发布到 GitHub Releases 并只保留最新 3 个 Release（保留旧 Git Tag）。构建产物作为 Actions Artifacts 保留 7 天。

发布新版本（例如 `v0.1.20`）：

1. 同步更新 `.github/release-version.txt`、`frontend/package.json`、`frontend/package-lock.json`、`frontend/src/App.tsx` 中的默认版本，以及 `wails.json` 的版本，并更新 `CHANGELOG.md`。
2. 将版本更新推送到 `main`。**不需要手工创建 Git Tag**：同一提交的 CI 通过后会自动构建 Windows 安装版与便携版，发布时自动创建 Tag。
3. 若 CI 失败，不会发布新版本；修复后重新推送版本标记更新或执行一次新的版本提交。

只想手动打包进行验证时，在 GitHub Actions 选择 **Build and release Windows → Run workflow**。手动运行只上传供下载的 Actions Artifacts，不创建或替换 GitHub Release。正式发布以 CI 结果为门禁，避免未经测试的安装包覆盖已有版本。


其他系统目前用于核心测试与 Windows 交叉编译；第一版只交付 Windows 桌面应用。

## 验证

```sh
go test -race ./...
go vet ./...
cd frontend
npm test -- --run
npm run build
npx playwright install chromium
npx playwright test
```

后端测试使用可控 SSH 服务与模拟 API，不需要真实服务器和付费密钥。浏览器端到端测试使用模拟 Wails 桥接；它验证界面流程，不替代 Windows 原生运行验证。

Windows 实测范围和操作步骤见 [验证记录](docs/windows-acceptance.md)，版本变化见 [CHANGELOG](CHANGELOG.md)。

## 当前边界

- 暂无 SFTP、跳板机、SSH agent、云同步；会话导入当前支持 Xshell `.xts`/`.xsh` 和 OpenShell 原生 JSON 备份，不支持直接导入 Xshell 保存的密码；快速命令是本地保存的模板，支持多行及末尾换行控制执行，不支持参数占位符。
- 指纹变化时阻止连接；第一版不提供直接覆盖已信任指纹的按钮。
- 已知小问题：近期终端历史已按上限裁剪时，预览可能遗漏截断提示；发送文本仍受 200 行/32 KiB 限制。
- Windows 原生输入法、剪贴板、凭据存储与性能仍需实机验证；真实模型与自定义接口的工具调用支持情况需分别验证。

### AI conversation memory

Each saved server connection owns a shared list of conversations. SSH tabs can
choose different conversations or view the same conversation with synchronized
messages. Use the conversation selector to create, rename, delete or resume a
conversation; duplicated SSH tabs resume the server's last selected conversation.

History and summaries are stored locally and survive closing tabs or restarting
OpenShell. Clearing or deleting a conversation affects every tab viewing it.
Only the tab that starts a request can control its commands; reconnecting never
resumes a pending command or automatic task.

AI settings include **Save conversation history** and **Summarize long
conversations**, both enabled by default. Turning saving off starts shared
temporary conversations and leaves existing saved history intact. Turning it
back on restores saved history without saving the temporary content. Stop active
tasks before changing the storage mode.

Long conversations use a summary plus recent complete turns. The default request
budget is 48 KiB of serialized data, not an exact Token limit. Summarization uses
the selected model and may consume additional credits; if it fails, OpenShell
keeps the original history and uses bounded recent context. Server output is
included only when explicitly attached or returned by an AI-executed command.

## Code signing policy / 代码签名策略

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

Windows release binaries (`OpenShell.exe`, the portable ZIP and the `Setup.exe` installer) are built from this repository by GitHub Actions (`.github/workflows/windows-release.yml`) and signed through SignPath. Only artifacts built from this repository's source code are signed.

**Team roles**

- Committers and reviewers: [hctty27](https://github.com/hctty27)
- Approvers: [hctty27](https://github.com/hctty27)

**Privacy policy**

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. Connections to SSH/SFTP servers and to AI providers are only made to endpoints that the user configures.
