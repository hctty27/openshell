# Privacy policy — OpenShell

**Effective: 2026-11-05.** This policy describes the public Windows desktop build as reviewed in the [source repository](https://github.com/hctty27/openshell). It is not a privacy policy for every SSH server, model provider, Windows component, or website that the user may choose to use.

## Data stored on your computer

- Session profiles, folders, SSH host-key trust records, preferences, saved AI provider settings, and saved conversations are stored in local SQLite data (normally `%APPDATA%\OpenShell\state.db`). Conversation records may include your prompts, AI answers, tool calls and terminal outputs.
- Saved SSH passwords, private-key passphrases, and AI provider API keys are stored through Windows Credential Manager. A private key remains at the path the user selected; the app stores that path.
- A local diagnostic collector can store bounded operation categories, error codes, timings and resource counters in the OpenShell cache directory. It deliberately excludes terminal text, raw command text, credentials, host addresses and file contents. It is **not uploaded** by OpenShell. Exporting a diagnostic ZIP is a separate user action, and sharing that ZIP is up to the user.
- User-requested uploads, downloads, file editing, and session backup/export operate on paths the user chooses. A session backup may include hostnames and user names but is not a credential backup.

## When information leaves the device

| Action | Recipient | Potential data |
| --- | --- | --- |
| Connect or reconnect a configured SSH/SFTP session; transfer a file; execute remote commands | The destination SSH server (or user-configured connection route) | Host connection and login details, terminal input/output, chosen file data and paths according to the requested action |
| Send a message to a configured AI model or invoke AI command execution / context compaction | The API base URL configured by the user | API key in the authorization header, conversation messages, selected terminal context and command results, and relevant session or execution metadata as included in the AI request |
| Click a project download, documentation, external link, or report link | The opened site, such as GitHub or Microsoft | Standard browser/network request metadata governed by that site's practices |

AI requests use the OpenAI-compatible chat-completions endpoint of the **user-selected** provider. OpenShell allows `http://` as well as `https://` endpoints; prefer HTTPS, because HTTP does not protect the API request contents in transit. The AI provider determines its own storage, retention and training policies; consult the selected provider's policy before sending terminal content or credentials. Do not submit secrets as prompts or terminal context.

OpenShell does not operate its own account-sync, central telemetry or crash-upload server in the reviewed application implementation. Diagnostics remain local until the user explicitly exports/shares them. The project maintainer does not automatically receive session profiles or AI conversations.

## Other software and services

- SSH and SFTP remote systems are controlled by their respective operators; their privacy and logging practices are outside OpenShell's control.
- AI model services are chosen and configured by the user. Their applicable privacy policies vary by endpoint and provider.
- Windows and Microsoft Edge WebView2 Runtime are Microsoft components with their own privacy behavior. See the [Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement).
- GitHub hosts source and release files. Its website and download services are governed by the [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
- Bundled upstream ZMODEM utilities process transfers between the local application and user-requested remote sessions. See [third-party review](docs/third-party-review.md) for project and license links.

## Installation, uninstall and retention

The Windows installer uses the current user's profile and creates files under `%LOCALAPPDATA%\Programs\OpenShell`, Start-menu/desktop shortcuts, and per-user uninstall registry entries. The uninstaller removes installed files and shortcuts; it does not automatically promise deletion of `%APPDATA%\OpenShell\state.db`, Windows Credential Manager entries or diagnostic files. For a complete local-data cleanup, review and remove the OpenShell profile and credential entries yourself after backing up anything you need.

OpenShell does not set a remote retention period for user-chosen SSH servers or AI API providers. Local stored data persists until the user changes/deletes it or removes the related Windows data. Diagnostic records are rotated and pruned by the collector; see [diagnostics](docs/diagnostics.md) for current limits.

## Questions or changes

Contact the maintainer through [GitHub Issues](https://github.com/hctty27/openshell/issues); do not post passwords, API keys, or unredacted server logs in public tickets. This document should be updated when network communication, diagnostics, or data-storage behavior changes.

---

## 中文隐私说明

OpenShell 将 SSH 会话、文件夹、偏好和 AI 对话保存在本机 SQLite 中，SSH 密码及 AI API Key 通过 Windows 凭据管理器保存。私钥通常只记录文件路径，不复制私钥内容。

**会主动产生网络通信的场景：** 连接用户配置的 SSH/SFTP 服务器、执行远程命令和传输文件；使用用户配置的 AI 模型时，向其 API 地址发送对话、相关终端上下文、命令结果及鉴权信息；用户点击外部文档、下载等链接时，由浏览器联系对应网站。AI 服务商和远程服务器有各自的隐私政策。建议 AI API 使用 HTTPS。

本地诊断记录只收集分类、错误码、性能时间等有限信息，不包含终端正文、密码或文件内容；软件不会自动把诊断文件上传至 OpenShell 服务器。导出诊断 ZIP 和分享均需用户自己操作。

卸载程序会删除已安装文件、快捷方式等，但**不会保证自动清除历史会话数据库、Windows 凭据或诊断文件**。请按需手动清理。第三方服务隐私、组件来源和许可证详见上文链接及 [第三方审查](docs/third-party-review.md)。
