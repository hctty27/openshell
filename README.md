# OpenShell

<img src="build/appicon.png" alt="OpenShell 应用图标" width="88" height="88" />

轻量的 Windows SSH 客户端，集成会话管理、多标签终端和可自定义 API 的 AI 助手。

**项目地址：** https://github.com/hctty27/openshell

**当前版本：** 0.1.9（测试版）

支持浅色/深色主题：设置 → 外观 → 主题，点击“保存外观”后重启保留。终端采用固定 6px 细滚动条，并修复末行裁切。

## 功能

- **会话管理**：Xshell 风格的紧凑树形分组、搜索、下方只读会话详情（管理菜单仍可编辑）、密码和本地私钥认证。
- **SSH 终端**：多标签、UTF-8、256 色、窗口尺寸同步、字体调整，支持 vim/top 和交互式 sudo。
- **快速命令栏**：终端下方固定「管理」按钮，后接自定义命令；单行模式为紧凑的 27px，横向滚动；多行模式按内容扩展。支持分类、排序、全局/分组/会话作用范围及执行前确认。
- **AI 助手**：流式对话、终端日志预览、每标签独立上下文。
- **自定义 API**：Base URL、API Key、模型 ID、多配置，兼容 OpenAI Chat Completions。
- **命令执行**：AI 提议命令，用户确认后执行，回传 stdout、stderr、退出码和耗时；支持拒绝、修改、超时和取消。
- **本地凭据**：Windows 凭据管理器保存密码、私钥口令与 API Key。

## 使用

1. 从 [Releases](https://github.com/hctty27/openshell/releases) 下载 Windows x64 的安装版（Setup.exe）或便携版（ZIP）。便携版解压后运行 **OpenShell.exe**。
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

## 执行方式

AI 命令通过当前已认证的 SSH 连接直接在远程服务器执行，不需要再次运行 `ssh user@host`。

快速命令与 AI 命令的执行方式不同：快速命令会写入当前交互式终端（PTY），因此使用当前 shell 的目录和环境变量。请确保终端处于 shell 提示符状态；若当前正在使用 vim/top、正在输入密码或运行其他交互式程序，快捷输入可能被该程序接收。

每次使用独立 exec 通道，不继承手动终端里的 `cd`、临时环境变量、虚拟环境或 sudo 身份。执行前可检查并修改远程绝对工作目录；默认使用远程 HOME。

- 每标签同时最多一个待处理命令，逐条确认。
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

产物：`build/bin/OpenShell.exe`。仓库的 [Windows 自动打包工作流](.github/workflows/windows-release.yml) 还会生成 ZIP 便携包和 NSIS 安装包，并在新版本首次构建成功时上传到 GitHub Releases。前后端绑定位于 `frontend/wailsjs`，由 Wails 自动生成。

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

- 暂无 SFTP、跳板机、SSH agent、云同步和会话导入；快速命令是本地保存的单行模板，不支持参数占位符。
- 指纹变化时阻止连接；第一版不提供直接覆盖已信任指纹的按钮。
- 已知小问题：近期终端历史已按上限裁剪时，预览可能遗漏截断提示；发送文本仍受 200 行/32 KiB 限制。
- Windows 原生输入法、剪贴板、凭据存储与性能仍需实机验证；真实模型与自定义接口的工具调用支持情况需分别验证。
