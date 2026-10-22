# OpenShell Shared Conversation Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 为每个服务器提供可恢复的多条 AI 对话，让多个 SSH 标签页共享列表与消息，并对长对话自动摘要。

**Architecture:** SQLite 是持久化记录的唯一事实来源；对话服务按 conversationID 管理选择、revision 和运行所有权，SSH 标签页仍拥有执行连接。前端按 conversationID 共享消息缓存，按 tabID 保存当前选择。上下文构造器负责摘要与完整工具轮次预算，不改变 SSH 执行权限。

**Tech Stack:** 现有 Go 1.26、SQLite、Wails v2、React 19、TypeScript、Vitest、Playwright；不新增运行时依赖。

**Spec:** [2026-10-22-conversation-memory-design.md](../specs/2026-10-22-conversation-memory-design.md)，已获用户审阅确认。

## Global Constraints

- 服务器隔离键包含保存会话 ID、规范化 host、port、username；使用实际 ConnectedSession，不能只按 IP 合并。
- 同服务器多标签页共享对话列表，各自独立选择；复制标签恢复最近选择，不自动新建。
- 同一对话只允许一个 AI 请求或自动任务运行；所有权包含等待确认、摘要、执行与自动任务暂停阶段。
- 运行固定 ownerTabID、ConnectionRef 和 conversationID；旁观者不能确认、停止或接管命令。
- 重连恢复历史，不恢复执行提案、自动任务或权限；未知执行结果不得自动重试。
- SQLite user_version=2；迁移必须保留原有数据且重复打开不降级版本。
- 上下文默认 48 KiB；完整轮次超过 20 或预算不足触发摘要；尽量保留最近 6 轮；摘要上限 8 KiB，单批输入 32 KiB，超时 30 秒。
- 消息分页 100 条，对话列表分页 50 条；次排序稳定；标题首行最多 40 个 Unicode 字符。
- 保存聊天记录与自动摘要默认开启；关闭保存使用服务器内共享临时集合，切换设置前停止全部任务。
- 英文默认、中文同步；不修改 release marker，不合并主干、不发布版本。

## Review Focus

1. 中文、emoji、超长首行与空标题：按 Unicode 字符限制，空标题使用当前语言占位。由 Task 1/6 测试。
2. 编辑服务器配置时旧标签仍连接原目标：历史归属与命令执行均使用旧连接的真实目标。由 Task 3 测试。
3. 同一对话在加载快照时收到重复或乱序事件：消息不丢失、不重复、不回滚。由 Task 5 测试。
4. 在等待确认、达到自动任务上限和关闭标签时竞争清空：只允许结束后的清理，迟到回调不能复活历史。由 Task 2/3 测试。
5. 数据库满/关闭、摘要取消与重启时未配对工具调用：不能伪装保存成功或执行成功。由 Task 1/3/4 测试。

## File Structure and Data Contracts

新增 internal/domain/conversation.go 定义存储和桥接 DTO，不导入 ai 或 store：

- Conversation：ID, ServerKey, SessionID, Title, Summary string；SummaryThroughSeq, Revision int64；CreatedAt, UpdatedAt string。
- ConversationMessage：ID, ConversationID, Role, Content, ToolCallID, Status, CreatedAt string；Seq int64；ToolCallsJSON, DisplayJSON json.RawMessage。
- ConversationCursor：UpdatedAt, ID string；ConversationList：Items []Conversation, NextCursor *ConversationCursor。
- ConversationPage：Conversation Conversation, Messages []ConversationMessage, BeforeSeq int64, HasMore bool, Run *ConversationRun。
- ConversationRun：ID, ConversationID, Kind, Status string；OwnerRef ConnectionRef。
- ConversationEvent：EventID, ServerKey, ConversationID, Kind string；Revision int64；EventSeq uint64；Run *ConversationRun；Message *ConversationMessage；Delta string；SelectedByTab map[string]string。
- ConversationMutation：Kind string；Message *ConversationMessage；Summary string；SummaryThroughSeq int64。

存储不理解 AI 协议；internal/ai/history.go 显式转换持久化消息与现有 ai.Message。事件中的 OwnerRef 来自 Run；历史事件不能使用观看标签页的 generation 做过滤。

## Task 1: SQLite 历史存储与迁移

**Files:** Create internal/domain/conversation.go, internal/store/conversations.go, internal/store/conversations_test.go；Modify internal/store/sqlite.go, internal/store/sqlite_test.go。

**Interfaces:**
- Store.CreateConversation(ctx context.Context, serverKey, sessionID string) (domain.Conversation, error)
- Store.ListConversations(ctx context.Context, serverKey string, cursor *domain.ConversationCursor, limit int) (domain.ConversationList, error)
- Store.GetConversation(ctx context.Context, id string) (domain.Conversation, error)
- Store.ReadConversation(ctx context.Context, id string, beforeSeq int64, limit int) (domain.ConversationPage, error)
- Store.LastConversation(ctx context.Context, serverKey string) (string, error)
- Store.SelectConversation(ctx context.Context, serverKey, id string) error
- Store.RenameConversation(ctx context.Context, id, title string) (domain.Conversation, error)
- Store.MutateConversation(ctx context.Context, id string, expectedRevision int64, change domain.ConversationMutation) (domain.Conversation, error)
- Store.DeleteConversation(ctx context.Context, id string) error
- Store.DeleteSession 的事务同时清理 conversations/messages/selections；删除对话和选择回退由 Task 2 串行调度。

- [ ] **Step 1: 写失败测试。** TestConversationMigrationPreservesV1、TestConversationPersistenceAcrossRestart、TestConversationStablePagination、TestConversationRevisionRejectsStaleWrite、TestConversationIDIsIdempotent、TestConversationClosedDatabaseReturnsError、TestConversationTitleUsesRunes。复用现有临时 SQLite；构造同 updated_at 的 51 条记录验证第二页无丢失/重复；查询迁移版本必须等于 2；重复打开仍为 2；关闭再打开消息数和摘要完全相同。
- [ ] **Step 2: 运行红灯。** go test ./internal/store -run Conversation -count=1；确认失败来自缺少 DTO/存储 API，而非外部依赖。
- [ ] **Step 3: 实现上述接口。** 独立迁移函数取代每次写 user_version=1；事务新增设计中的三表与索引。MutateConversation 仅接受 append/clear/summary；append 以 (conversation_id, id) 唯一索引实现消息 ID 幂等、分配单调 seq；clear 清消息和摘要、revision 增加；summary 比较 revision 且不删除原消息。标题输入去首尾空白，空值代表自动标题；首条用户消息自动标题最多 40 rune，手动标题不被后续追加覆盖（增加 title_manual 字段记录来源）。
- [ ] **Step 4: 运行绿灯。** go test ./internal/store ./internal/domain -count=1。检查故障路径事务回滚后消息和 revision 均不变。
- [ ] **Step 5: 提交。** git add internal/domain/conversation.go internal/store；git commit -m "feat(memory): persist conversations and migrate SQLite safely"。

## Task 2: 共享对话服务与运行所有权

**Files:** Create internal/conversation/service.go, internal/conversation/runs.go, internal/conversation/service_test.go, internal/conversation/runs_test.go。

**Interfaces:**
- NewService(db *store.Store, emit func(domain.ConversationEvent)) *Service
- ServerKey(session domain.Session) string
- Service.Bind(ctx context.Context, ref domain.ConnectionRef, session domain.Session) (domain.Conversation, error)
- Service.Unbind(ref domain.ConnectionRef)；Service.Selected(ref domain.ConnectionRef) (string, error)
- Service.Create(ctx context.Context, ref domain.ConnectionRef) (domain.Conversation, error)
- Service.Select(ctx context.Context, ref domain.ConnectionRef, id string) (domain.ConversationPage, error)
- Service.List(ctx context.Context, ref domain.ConnectionRef, cursor *domain.ConversationCursor, limit int) (domain.ConversationList, error)
- Service.Read(ctx context.Context, ref domain.ConnectionRef, id string, beforeSeq int64, limit int) (domain.ConversationPage, error)
- Service.Rename(ctx context.Context, ref domain.ConnectionRef, id, title string) (domain.Conversation, error)
- Service.Clear(ctx context.Context, ref domain.ConnectionRef) error；Service.Delete(ctx context.Context, ref domain.ConnectionRef, id string) error
- Service.Begin(ref domain.ConnectionRef, kind string) (domain.ConversationRun, error)
- Service.CheckOwner(runID string, ref domain.ConnectionRef) error；Service.End(runID string)
- Service.Append(ctx context.Context, runID string, message domain.ConversationMessage) error
- Service.EmitDelta(runID, messageID, text string) error
- Service.Configure(ctx context.Context, save bool) error

- [ ] **Step 1: 写失败测试。** TestTabsShareListsAndChooseIndependently：同一保存配置 Bind 两次得到相同 ID；Create 只改变发起标签选择；另一个标签可 Select 新对话。TestRunLeaseSerializesConversation：并发 Begin 仅一成功；暂停/等待确认仍持有；另一个对话可运行。TestSharedClearAndDeleteFallback：观察标签选择同步回退，清空另一对话不受影响。TestServerKeyUsesActualIdentity：改名键不变，host/port/user/sessionID 任一变化键改变。TestEphemeralModeNeverWritesStoredHistory：关闭保存后重启只见原记录。
- [ ] **Step 2: 运行红灯。** go test ./internal/conversation -count=1，确认缺少服务。
- [ ] **Step 3: 实现服务与内存运行表。** 使用每条对话锁和短生命周期服务锁，网络调用期间不持锁。Bind 在同一服务器并发首次打开时只创建一个默认对话。Begin 同时约束标签和对话，End 仅释放相同 runID。删除最后一条时原子产生一个替代对话并更新全部查看者。Configure 检查无运行任务后切换持久化/内存存储，临时内容不迁移到数据库。所有变更只在提交成功后 emit。
- [ ] **Step 4: 运行绿灯与竞态测试。** go test -race ./internal/conversation -count=1；并发清空、删除、Begin、Append、Select 无数据竞争且过期 runID 被拒绝。
- [ ] **Step 5: 提交。** git add internal/conversation；git commit -m "feat(memory): share server histories with per-conversation run ownership"。

## Task 3: 接入聊天、连接与命令生命周期

**Files:** Create conversation.go, conversation_integration_test.go, internal/ai/history.go, internal/ai/history_test.go；Modify app.go, automatic.go, app_integration_test.go, app_test.go。

**Interfaces:**
- App.ListConversations(ref domain.ConnectionRef, cursor *domain.ConversationCursor, limit int) (domain.ConversationList, error)
- App.CreateConversation(ref domain.ConnectionRef) (domain.Conversation, error)
- App.SelectConversation(ref domain.ConnectionRef, id string) (domain.ConversationPage, error)
- App.ReadConversation(ref domain.ConnectionRef, id string, beforeSeq int64, limit int) (domain.ConversationPage, error)
- App.RenameConversation(ref domain.ConnectionRef, id, title string) (domain.Conversation, error)
- App.DeleteConversation(ref domain.ConnectionRef, id string) error
- ConnectResult 增加 ConversationID string；ChatRequest 增加 RequestID string（稳定去重），conversationID 从服务绑定获取。
- ai.ReplayHistory(messages []domain.ConversationMessage) ([]ai.Message, error)：缺结果工具调用生成明确“结果未知，禁止自动重跑”的配对 tool 消息；incomplete assistant 不作为完整回复重放。
- 所有执行控制入口显式传入调用标签的 Ref 并校验运行所有者：App.ConfirmCommand(ref domain.ConnectionRef, id string) (domain.CommandResult, error)、App.ReviseProposal(ref domain.ConnectionRef, id, command, cwd string, seconds int) (domain.Proposal, error)、App.CancelCommand(ref domain.ConnectionRef, id string) error、App.CancelChat(ref domain.ConnectionRef) error、App.ResumeAutomatic(ref domain.ConnectionRef, taskID, approvedProposalID string, extend bool) (tasks.AutoSnapshot, error)、App.StopAutomatic(ref domain.ConnectionRef, taskID string) error。连接失效清理使用独立的私有取消方法，不能绕用需要活跃 Ref 的公开入口；自动 runner 的内部取消同样固定原 ownerRef。
- ChatRequest/回复/命令事件关联运行 ID；现有 tabID ConversationStore 由服务替代，测试断言迁移到 ReadConversation。更新所有 Go 调用方、桥接与测试替身以匹配新控制签名。

- [ ] **Step 1: 写失败测试。** 复用 testssh.Start 与 httptest SSE：TestSharedConversationSurvivesAppRestart、TestEditingLiveSessionKeepsHistoryTarget、TestObserverCannotControlProposal、TestClosingOwnerStopsSharedRun、TestClearRejectsWhileAwaitingConfirmation、TestRestorePendingToolDoesNotExecute、TestPersistFailurePreventsCommandExecution。断言 SSH 命令计数和实际结果，而不是只断言 mock 被调用；历史显示 incomplete/unknown，恢复时命令计数不增加。
- [ ] **Step 2: 运行红灯。** go test ./... -run 'SharedConversation|HistoryTarget|Observer|SharedRun|ClearRejects|RestorePending|PersistFailure' -count=1。
- [ ] **Step 3: 接入 Service。** Connect 仅在 SSH 成功并校验 epoch 后 Bind 实际 ConnectedSession，challenge 不创建对话。重连/CloseTab 仅取消运行与释放绑定；ClearChat 调用服务共享清空。每轮请求持有 Begin 返回的 runID；等待确认不 End；Continue 沿用所有权，纯聊天回复结束或错误才 End。StartAutomatic 在任务启动前获取所有权，到 completed/stopped/error 才释放，limit/awaiting_confirmation 不释放。旧 callbacks 必须携带 runID，不能写新绑定。
- [ ] **Step 4: 完成持久化事件链并运行绿灯。** 用户消息请求前保存，回复 SSE 结束提交，已接收但中断文本保存 incomplete。工具提案先存 tool_call，结果在实际执行后写入；落盘错误显式返回，结果未知不得重执行。脱敏覆盖 content、tool arguments、display_json；使用结构化 JSON 处理，不能用字符串替换破坏工具参数。运行 go test ./... -count=1，确认现有两服务器隔离、连接中关闭、编辑连接测试仍通过。
- [ ] **Step 5: 提交。** git add app.go automatic.go conversation.go '*test.go' internal/ai/history*；git commit -m "feat(memory): restore shared chats without restoring execution permissions"。

## Task 4: 有界上下文与自动摘要

**Files:** Create internal/ai/memory.go, internal/ai/memory_test.go, conversation_context.go, conversation_context_test.go；Modify internal/ai/provider.go, conversation.go, app.go。

**Interfaces:**
- ai.ContextPolicy：MaxRequestBytes, SummaryBytes, SummaryInputBytes, KeepTurns, TriggerTurns int；SummaryTimeout time.Duration。
- ai.DefaultContextPolicy() ai.ContextPolicy：48*1024, 8*1024, 32*1024, 6, 20, 30*time.Second。
- ai.ContextResult：Messages []ai.Message, Summary string, ThroughSeq int64, Status string。
- ai.SummaryFunc：func(context.Context, []ai.Message) (string, error)。
- ai.BuildContext(ctx context.Context, system ai.Message, history []domain.ConversationMessage, summary string, throughSeq int64, policy ai.ContextPolicy, summarize ai.SummaryFunc, requestSize func([]ai.Message) (int, error)) (ai.ContextResult, error)。
- Provider.RequestSize(profile domain.APIProfile, messages []ai.Message) (int, error)：与 Stream 共用序列化逻辑，包含 tools/model/stream。
- App.prepareConversationContext(ctx context.Context, run domain.ConversationRun, profile domain.APIProfile, key, language string, system ai.Message) ([]ai.Message, error)。

- [ ] **Step 1: 写失败测试。** TestContextDefaultPolicy 精确断言上述六个默认值；TestSummaryTriggersAfter20CompleteTurns；TestBudgetIncludesJSONEscapingAndTools；TestKeepToolChainAtomic；TestSummaryFailureRetainsRawHistory；TestSummaryCancelledSkipsMainRequest；TestOversizedCurrentTurnReturnsError；TestStaleSummaryCannotResurrectClearedHistory。工具链 fixture 含多次工具执行，中文、引号和控制字符 fixture 验证按实际 JSON 字节计数。
- [ ] **Step 2: 运行红灯。** go test ./internal/ai ./... -run 'ContextDefault|Summary|Budget|ToolChain|OversizedCurrent' -count=1。
- [ ] **Step 3: 实现完整轮次切分与摘要。** 只压缩完整旧轮次；摘要请求禁用工具且不发 UI 聊天事件，使用当前运行冻结的 profile/key/语言。摘要以明确标记的历史资料 user 消息加入上下文，不承载 system 权限。成功用 expectedRevision 提交，失败保留原摘要/进度，降级到预算内完整近期轮次并发状态；取消直接终止；单条不可拆分输入过大返回可翻译错误。
- [ ] **Step 4: 运行绿灯。** go test ./internal/ai ./... -count=1；集成 SSE 服务验证摘要取消时主回复请求数为 0，摘要请求无 tools，原始 SQLite 消息数不减少。主请求真实 RequestSize 不超过 48*1024。
- [ ] **Step 5: 提交。** git add internal/ai conversation_context* conversation.go app.go；git commit -m "feat(memory): summarize long histories within a bounded request budget"。

## Task 5: 前端共享缓存、事件合并与桥接

**Files:** Create frontend/src/conversations.ts, frontend/src/conversations.test.ts, frontend/src/useConversations.ts, frontend/src/ConversationMemory.test.tsx；Modify frontend/src/App.tsx, frontend/src/bridge.ts, frontend/src/types.ts, frontend/wailsjs/go/main/App.js, frontend/wailsjs/go/main/App.d.ts, frontend/wailsjs/go/models.ts, frontend/src/App.test.tsx, frontend/e2e/workspace.spec.ts。

**Interfaces:**
- Conversation/ConversationMessage/ConversationPage/ConversationEvent 类型与 domain JSON 名称保持一致。
- ConversationCache：按 conversationID 保存 messages、revision、run、summaryStatus、hasMore、loading、error；tab 当前选择单独保存在 Tab.conversationID。
- reduceConversationEvent(cache: ConversationCache, event: ConversationEvent): ConversationCache。
- mergeConversationPage(cache: ConversationCache, page: ConversationPage): ConversationCache。
- useConversations() 返回 cache、selectedByTab、list、create、select、rename、remove、loadEarlier、clear，函数参数与 Task 3 后端接口一致；所有 API 操作显示失败状态。
- App 中的 send/automatic 生成稳定 RequestID，不再按 tabID 独立追加相同后端消息。

- [ ] **Step 1: 写失败测试。** reducer 测试 assertions：重复 eventID 只留一条，旧 revision 不回滚新状态，快照加载期间 delta 保留，100 条分页合并无重复；ownerRef.generation 与观看者不同仍显示共享消息。React 测试：两个标签选择同一 conversationID 显示同一回复；切换其中一个不影响另一个；恢复失败不以空白覆盖缓存。
- [ ] **Step 2: 运行红灯。** cd frontend && npm test -- --run src/conversations.test.ts src/ConversationMemory.test.tsx。
- [ ] **Step 3: 实现缓存与订阅。** 先订阅 conversation:event 再读快照，按 revision 与稳定消息 ID 合并；stream delta 同时有单调事件序号，乱序时缓冲或重新读取快照，不盲目忽略中间段。连接成功恢复选中 ID；复制标签按后端结果恢复，重连不清空共享缓存；关闭仅删除标签选择。执行控制以 ownerRef 校验，不向旁观者暴露可操作 Proposal。
- [ ] **Step 4: 生成/核验 Wails 绑定并运行绿灯。** 用仓库安装的 Wails CLI 生成绑定；不可用时按既有生成格式更新并在可运行环境复验。补全所有现有 mock 后端、e2e 替身的新方法和事件；cd frontend && npm test -- --run && npm run build。
- [ ] **Step 5: 提交。** git add frontend/src frontend/wailsjs frontend/e2e/workspace.spec.ts；git commit -m "feat(memory): synchronize shared conversation state across tabs"。

## Task 6: 对话管理界面、设置与双语

**Files:** Create frontend/src/components/ConversationPicker.tsx, frontend/src/components/ConversationPicker.test.tsx；Modify frontend/src/components/AISidebar.tsx, frontend/src/components/AISidebar.test.tsx, frontend/src/components/SettingsDialog.tsx, frontend/src/styles.css, frontend/src/locales/en/ai.json, frontend/src/locales/zh-CN/ai.json, frontend/src/locales/en/settings.json, frontend/src/locales/zh-CN/settings.json, frontend/src/locales/en/errors.json, frontend/src/locales/zh-CN/errors.json, frontend/src/locales/en/common.json, frontend/src/locales/zh-CN/common.json, app.go, frontend/src/types.ts。

**Interfaces:**
- ConversationPicker props：items: Conversation[]、selectedID: string、busy: boolean、hasMore: boolean；onSelect(id)、onCreate()、onRename(id,title)、onDelete(id)、onLoadMore()。
- AppState 增加 SaveChatHistory/AutoSummarize bool，JSON 为 saveChatHistory/autoSummarize；SavePreference 仅新增这两个布尔白名单键，缺失值默认 true。
- AISidebar 增加 ownerTabID、onFocusOwner(tabID)、onLoadEarlier() 与共享状态；保留原有模型/模式栏位置。

- [ ] **Step 1: 写失败测试。** TestMemorySettingsDefaultOnAndValidate、TestCannotToggleStorageWhileRunning；UI：新增对话只切换当前标签、列表分页 50、消息分页 100、同名与 emoji 标题可区分 ID、自动标题 40 rune、中英文空标题不固化、忙碌旁观者看见跳转但没有确认/停止按钮。清空弹窗显示“所有查看此对话的标签页都会同步清空”，删除最后一条后所有查看者得到同一个新 ID。
- [ ] **Step 2: 运行红灯。** go test ./... -run 'MemorySettings|ToggleStorage' -count=1；cd frontend && npm test -- --run src/components/ConversationPicker.test.tsx src/components/AISidebar.test.tsx。
- [ ] **Step 3: 实现紧凑选择器和设置。** 复用现有 DialogProvider/FloatingContextMenu，不引入原生 alert/confirm/prompt。设置在现有 AI 分类内呈现；关闭自动摘要显示有界近期上下文提示。发起标签忙碌时禁用对话切换，其他标签可选择；正在另一标签运行状态保留可跳转入口。所有新文案英文/中文成对定义。
- [ ] **Step 4: 运行绿灯。** go test ./... -count=1；cd frontend && npm test -- --run && npm run build；在窄侧栏和深浅主题检查标题截断、按钮可用与键盘操作。
- [ ] **Step 5: 提交。** git add app.go frontend/src；git commit -m "feat(memory): add bilingual conversation history controls and settings"。

## Task 7: 端到端验收与整分支审查

**Files:** Create frontend/e2e/conversation-memory.spec.ts；Modify README.md, docs/windows-acceptance.md；必要的修复仅限上述实现。

- [ ] **Step 1: 编写并运行新的 e2e 用例。** 两个同服务器 SSH 标签共享列表与流式回复；不同对话独立；关闭重开恢复；旁观者不能执行；清空/删除同步；断开发起连接任务停止；中文/英文及深浅主题。先运行于未接完 UI 的版本确认能暴露缺失行为，再在完成版本运行；断言页面显示和后端持久化，而非截图存在。
- [ ] **Step 2: 跑完整检查。** go test ./... -count=1；go test -race ./internal/conversation ./internal/ai ./internal/store；cd frontend && npm ci && npm test -- --run && npm run build；npx playwright test；git diff --check。环境缺少 Go 1.26、Wails 或浏览器时先尝试配置，无法运行则逐项报告未验证项，不能声称全通过。
- [ ] **Step 3: 检查文档与整分支。** README/Windows 验收记录恢复规则、共享清空范围、摘要额外模型消耗、保存开关语义。对照 spec 的验收项逐条核对，检查数据库写入错误和网络取消；确认没有变更 .github/release-version.txt。
- [ ] **Step 4: 独立审查。** 执行方式由用户选择；Native 为当前代理实现，最后一次独立审查；Subagent-driven 为逐任务实现及审查。按用户选择使用对应执行技能，不在计划编写阶段启动代理。
- [ ] **Step 5: 提交验收改动并交付。** git add frontend/e2e/conversation-memory.spec.ts README.md docs/windows-acceptance.md；git commit -m "test(memory): verify persistence and shared-tab behavior"。推送 feature 分支，交付变更与验证结果；用户要求后再合并或发布。

## Self-Review

- 归属/恢复/连接挑战 → Tasks 1–3；并发与 owner 权限 → Tasks 2–3；摘要/取消/工具链 → Task 4。
- 列表/分页/共享消息/乱序/选择 → Tasks 5–6；设置/脱敏/删除/迁移 → Tasks 1–3/6；全量检查 → Task 7。
- 五项 Review Focus 分别有具名测试与可观察结果；Store 不导入 ai；服务和前端使用同一 conversationID，观看者不使用 owner generation 过滤消息。
- title_manual 是实现自动标题与保留手动标题所需的内部字段；不改变已批准的用户行为。
- 本计划仅编写和保存，尚未执行任何实现任务；需用户审阅并选择执行方式后开始。
