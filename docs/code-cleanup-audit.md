# OpenShell 代码瘦身审查（2026-10-27）

## 本次完成

- 删除 `frontend/src/features/terminal/splitDrop.ts` 中已无生产调用的首阶段兼容 API：`getSplitDropZone`、`splitLayoutFromDrop`。
- 将相关测试迁移至真实生产调用的 `getSplitDropIntent`，覆盖四个边缘、智能中心、滞后防抖与非法尺寸。
- 保留 `SplitDirection` 类型：`splitTree.ts` 仍直接依赖它。
- 删除旧终端状态、旧弹窗背景与旧字体控制对应的 7 条孤立 CSS 规则；已比对当前前端 JSX 组件引用，动态拼接状态类与 Wails 拖放类保留。
- 版本号的前端回退值直接取 `frontend/package.json`，避免旧版本硬编码。
- 添加 `npm run audit:unused` 检测 TypeScript 未使用声明和参数；CI 中以 advisory 方式运行。

## 后续清理候选（未直接删除）

1. **组件拆分**：`frontend/src/App.tsx` 与 `frontend/src/components/SettingsDialog.tsx` 文件较大，但代码行数不能作为死代码证据。应按连接、会话、AI、设置分层，逐步重构。
2. **CSS 级联**：`frontend/src/styles.css` 存在同名选择器的多次定义，其中包含有意覆盖以及媒体查询，必须结合实际渲染核对后再合并。
3. **旧数据兼容**：`QuickCommand.mode` 仍参与从旧保存格式到新命令行为的迁移，不能仅凭界面已移除相关开关就删除。
4. **Go 间接依赖**：`go.mod` 的 `// indirect` 不等于未使用，不应手动删除。
5. **SFTP/SSH/AI 自动执行**：保留事件处理、重连状态和历史数据相关的回退逻辑，先验证再决定删除。

## 本地审查与回归

```bash
cd frontend
npm ci
npm run build
npm test -- --run
npm run audit:unused
npx --yes knip --files
npx --yes knip --exports
npx --yes knip --dependencies
```

```bash
go test -race ./...
go vet ./...
go mod tidy -diff
```

**核对规则：** Knip 依赖入口文件与模块图；Wails 生成绑定、测试入口、运行时事件、平台专用 Go 文件和反射或动态调用可能导致误报。发现结果先核实可达性、兼容性以及调用方向，不自动批量删除。参见 [Knip 官方说明](https://knip.dev/guides/handling-issues)。

## 验证状态

本次 GitHub 连接支持源文件审查和提交。执行环境未能通过网络克隆 GitHub 仓库，故未在本地实际运行构建与测试；提交 PR 后以仓库 GitHub Actions 结果作为第一轮验证，并在 Windows 真实 SSH / SFTP / rz-sz 场景进行回归。

## 第二轮自动审查

- PR CI 中的 TypeScript unused-symbol audit 已成功执行（2026-10-27）。
- Knip 6.43.0 生产代码图扫描限定 `remove-unused` 类 PR 分支执行、`continue-on-error`，不会增加主干日常发布成本；不要直接将诊断视为删除授权。
- 现有 UI 的动态 CSS 规则（如 `connection-state-*`、`drag-before`、`terminal-split-drop-*`）虽不能用字面全文匹配确认调用，已主动排除清理范围。
