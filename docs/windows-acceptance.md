# OpenShell v0.1.5 验证记录

2026-10-21。v0.1.5 修复终端底部黑条与命令编辑框对比度。

| 检查 | 结果 |
| --- | --- |
| 前端单元测试 | 8 项通过；覆盖 AI 加载状态与主题预览、保存 |
| 前端生产构建 | 通过 TypeScript 检查及 Vite 构建 |
| 后端测试 | go test ./... 全部通过；包含主题保存后关闭并重新打开数据库的恢复验证 |
| 浏览器端到端测试 | 2 项通过；会话/API/AI 执行流程，以及连续输出、滚动条宽度、窗口调整、侧栏收起、主题切换、视口背景和刷新恢复；AI 命令框两种主题的普通/悬停/聚焦对比度均 ≥4.5:1 |
| 底部裁切回归 | 恢复旧内边距布局时几何断言失败，使用修复后的布局通过 |
| Windows x64 交叉编译 | Go production/desktop 构建成功 |
| Windows 原生启动及真实 API | 本次尚未实机验证 |

测试浏览器为 Chromium 153，桥接与 SSH 输出使用测试数据；Windows WebView2 实机效果仍需验收。

从 OpenShell v0.1.2/v0.1.3 升级保留配置；不读取 LightSSH 旧配置。

## Windows 人工验收步骤

1. 双击 exe；缺 WebView2 时安装微软运行时后重试。
2. 新建两个会话，分别测试密码和加密私钥；核验首次指纹提示。
3. 打开两个标签，中文输入、复制粘贴、vim/top、Ctrl+C、拖动窗口与调整字体。
4. 保存密码和 API Key，退出重启，确认配置与凭据可读；对话已清除。
5. 使用自己的兼容 API，分别测试普通对话与工具调用。
6. 两个标签各自对话并执行 pwd，核对主机与目录；重连后旧提议不可执行。
7. 执行有标准错误和非零退出码的测试命令，核对结果展示。
8. 执行 sleep 120 后停止，界面应显示结果未知，远端是否结束另行核实。
9. 断网、重连、关闭连接中的标签，确认无自动重跑和跨标签输出。

已知小问题：近期历史输出在预览前已按上限裁剪，截断标记可能缺失；未突破发送内容大小限制。

## Shared conversation memory

- Upgrade a v0.1.26 state.db; existing servers, credentials and preferences remain available.
- Connect two SSH tabs to the same saved server. They share the conversation list, including the latest selection on initial open, and synchronize messages when viewing one conversation.
- Create a new conversation in one tab. The other tab keeps its own selection and can independently select the new conversation.
- During generation, confirmation and an automatic task's round-limit pause, the same conversation accepts one task only. Other viewers can jump to the owner tab but cannot execute, revise, cancel or take over its commands.
- Close/disconnect the owner during streaming or execution. Other viewers see the partial reply or actual/unknown result; no command restarts automatically.
- Close tabs/restart the app and reconnect. History returns; pending commands and automatic task controls do not.
- Clear/delete a shared conversation and verify all viewers update. Other conversations remain intact; deleting the last creates one shared replacement.
- Verify rename, pagination (50 conversations / 100 messages), Chinese/English, light/dark themes and narrow AI sidebar layout.
- Toggle history saving only after stopping tasks. Temporary messages never appear when saved history is restored.
- Exceed 20 complete turns and check summary status. Disconnect the model during summarization: history remains, cancellation stops the request and no follow-up main request is sent.

Automated coverage includes real local SSH + SSE integration tests, full Go race
checks, Vitest, frontend build, and browser UI fixtures. Run this native Windows
checklist on the packaged desktop application before publishing a release.
