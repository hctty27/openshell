import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, History, LoaderCircle, Pin, PinOff, Plus, Search, Send, Sparkles, Square, Trash2, X } from "lucide-react";
import { api, errorText, listen } from "../bridge";
import type { AIConversation, AIProvider, AIStartResponse, AITargetBinding, Tab } from "../types";
import AIModelPicker from "./AIModelPicker";
import AITranscript from "./AITranscript";
import { AI_PROVIDERS_CHANGED } from "../features/ai/providerEvents";
import { readLastModel, saveLastModel } from "../features/ai/modelSelection";

interface Props {
  tabs: Tab[];
  active?: Tab;
  pinned: boolean;
  isOpen: boolean;
  terminalAlternate?: boolean;
  onTogglePin(): void;
  onClose(): void;
}

interface Approval {
  taskId: string;
  approvalId: string;
  command: string;
  reason: string;
  tabId: string;
}

export default function AISidebar({ tabs, active, pinned, isOpen, terminalAlternate = false, onTogglePin, onClose }: Props) {
  const lastModelRef = useRef(readLastModel());
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [conversations, setConversations] = useState<AIConversation[]>([]);
  const [conversationID, setConversationID] = useState("");
  const [providerID, setProviderID] = useState(lastModelRef.current.providerId);
  const [modelID, setModelID] = useState(lastModelRef.current.modelId);
  const [mode, setMode] = useState<"review" | "auto">("review");
  const [execution, setExecution] = useState<"auto" | "independent" | "terminal">("auto");
  const [targetIDs, setTargetIDs] = useState<string[]>([]);
  const [historySessionIDs, setHistorySessionIDs] = useState<string[]>([]);
  const [historyBindings, setHistoryBindings] = useState<AITargetBinding[]>([]);
  const [legacyHistoryNeedsRebind, setLegacyHistoryNeedsRebind] = useState(false);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [showTargets, setShowTargets] = useState(false);
  const [running, setRunning] = useState<AIStartResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stream, setStream] = useState("");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const finishedTasks = useRef(new Set<string>());
  const messagesRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const onMessagesScroll = () => {
    const node = messagesRef.current;
    if (!node) return;
    // 用户向上查看旧消息时停止跟随；回到底部时自动恢复。
    followOutputRef.current =
      node.scrollHeight - node.scrollTop - node.clientHeight <= 72;
  };

  useEffect(() => {
    // Older test fixtures may not expose the optional AI service methods.
    if (typeof api.AIProviders !== "function" || typeof api.AIConversations !== "function") return;
    let valid = true;
    Promise.all([api.AIProviders(), api.AIConversations()])
      .then(([p, c]) => {
        if (!valid) return;
        setProviders(p ?? []);
        setConversations(c ?? []);
      })
      .catch(e => { if (valid) setError(errorText(e)); });
    const refreshProviders = () => {
      void api.AIProviders().then(items => {
        if (valid) setProviders(items ?? []);
      }).catch(e => { if (valid) setError(errorText(e)); });
    };
    window.addEventListener(AI_PROVIDERS_CHANGED, refreshProviders);
    return () => {
      valid = false;
      window.removeEventListener(AI_PROVIDERS_CHANGED, refreshProviders);
    };
  }, []);

  useEffect(() => {
    const offConversation = listen("ai:conversation", (next: AIConversation) => {
      setConversations(old => [next, ...old.filter(item => item.id !== next.id)]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setStream("");
    });
    const offDelta = listen("ai:delta", (event: { taskId: string; text: string }) => {
      setStream(old => old + event.text);
    });
    const offState = listen("ai:state", (event: { taskId: string; status: string; detail: string }) => {
      setStatus(event.status === "completed" ? "" :
        event.status === "running" ? "正在执行" :
        event.detail || (event.status === "cancelled" ? "任务已取消" : "执行失败"));
      if (event.status !== "running") {
        finishedTasks.current.add(event.taskId);
        setRunning(old => old?.taskId === event.taskId ? null : old);
        setStream("");
        setApproval(null);
          }
    });
    const offApproval = listen("ai:approval", (event: Approval) => setApproval(event));
    return () => { offConversation(); offDelta(); offState(); offApproval(); };
  }, []);

  const connected = tabs.filter(tab => tab.status === "connected" && tab.ref);
  const requiredID = active?.status === "connected" ? active.id : "";
  // Restore logical session selections against live tabs, never stale connection references.
  const matchesHistoryTarget = (tab: Tab, sessionID: string) => {
    if (tab.session.id !== sessionID) return false;
    const binding = historyBindings.find(saved => saved.sessionId === sessionID);
    if (!binding) return true;
    return tab.session.host === binding.host
      && tab.session.port === binding.port
      && tab.session.username === binding.username;
  };
  const restoredTabIDs = historySessionIDs.flatMap(sessionID => {
    if (legacyHistoryNeedsRebind) return [];
    const matched = connected.filter(tab => matchesHistoryTarget(tab, sessionID));
    const preferred = matched.find(tab => tab.id === requiredID) ?? matched[0];
    return preferred ? [preferred.id] : [];
  });
  const unavailableSessionIDs = historySessionIDs.filter(sessionID =>
    !connected.some(tab => matchesHistoryTarget(tab, sessionID))
  );
  const targetSet = new Set([...targetIDs, ...restoredTabIDs, ...(requiredID ? [requiredID] : [])]);
  const targets = connected.filter(tab => targetSet.has(tab.id));
  const terminalSingleTarget = Boolean(
    active?.ref && targets.length === 1 &&
    targets[0]?.ref?.tabId === active.ref.tabId &&
    targets[0]?.ref?.generation === active.ref.generation,
  );
  const terminalAvailable = terminalSingleTarget && !terminalAlternate;
  const provider = providerID ? providers.find(item => item.id === providerID) : providers[0];
  const model = modelID ? provider?.models.find(item => item.id === modelID) : provider?.models[0];
  const current = conversations.find(item => item.id === conversationID);
  useLayoutEffect(() => {
    const node = messagesRef.current;
    if (!isOpen || !node || !followOutputRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [isOpen, conversationID, current?.messages, stream, status, error, approval]);
  const filteredHistory = conversations.filter(item =>
    [item.title, ...item.targetNames, ...item.messages.map(m => m.content)].join(" ").toLowerCase().includes(search.toLowerCase())
  );
  const toggleTarget = (id: string) => {
    if (id === requiredID) return;
    const sessionID = connected.find(tab => tab.id === id)?.session.id;
    if (targetSet.has(id)) {
      setTargetIDs(old => old.filter(selected => selected !== id));
      if (sessionID) {
        setHistorySessionIDs(old => old.filter(saved => saved !== sessionID));
        setHistoryBindings(old => old.filter(saved => saved.sessionId !== sessionID));
      }
    } else {
      setTargetIDs(old => [...old, id]);
    }
  };
  const selectConversation = (item: AIConversation) => {
    followOutputRef.current = true;
    setTargetIDs([]);
    const bindings = item.targetBindings ?? [];
    setHistoryBindings(bindings);
    setHistorySessionIDs(bindings.length ? bindings.map(saved => saved.sessionId) : (item.targetSessionIds ?? []));
    setLegacyHistoryNeedsRebind(item.targetNames.length > 0 && bindings.length === 0);
    setConversationID(item.id);
    setProviderID(item.providerId);
    setModelID(item.modelId);
    setMode(item.mode);
    setExecution("auto");
    setShowHistory(false);
    setStream("");
    setStatus("");
    setError("");
  };
  const newConversation = () => {
    if (running) return;
    followOutputRef.current = true;
    setTargetIDs([]);
    setHistorySessionIDs([]);
    setHistoryBindings([]);
    setLegacyHistoryNeedsRebind(false);
    setConversationID("");
    setExecution("auto");
    setProviderID(lastModelRef.current.providerId);
    setModelID(lastModelRef.current.modelId);
    setMessage("");
    setStream("");
    setStatus("");
    setError("");
    setShowHistory(false);
  };
  const chooseModel = (nextProviderID: string, nextModelID: string) => {
    setProviderID(nextProviderID);
    setModelID(nextModelID);
    const selected = { providerId: nextProviderID, modelId: nextModelID };
    lastModelRef.current = selected;
    saveLastModel(selected);
  };
  const removeHistory = async (id: string) => {
    try {
      await api.AIDeleteConversation(id);
      setConversations(old => old.filter(c => c.id !== id));
      if (conversationID === id) setConversationID("");
    } catch (e) { setError(errorText(e)); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (!text || !provider || !model || !targets.length || unavailableSessionIDs.length ||
      legacyHistoryNeedsRebind || submitting || running ||
      (execution === "terminal" && !terminalAvailable)) return;
    followOutputRef.current = true;
    setError("");
    setStatus("正在执行");
    setStream("");
    setSubmitting(true);
    try {
      const started = await api.AIStart({
        conversationId: conversationID, providerId: provider.id, modelId: model.id,
        mode, execution, text, targets: targets.map(tab => tab.ref!),
      });
      if (!finishedTasks.current.has(started.taskId)) setRunning(started);
      setConversationID(started.conversationId);
      setMessage("");
    } catch (e) { setError(errorText(e)); setStatus(""); }
    finally { setSubmitting(false); }
  };

  return (
    <aside className="ai-panel" aria-label="AI 助手" aria-hidden={!isOpen}>
      <header className="ai-header">
        <strong><Sparkles size={15} /> AI 助手</strong>
        <div className="ai-header-actions">
          <button title="全局对话记录" aria-label="全局对话记录" onClick={() => setShowHistory(!showHistory)}><History size={15} /></button>
          <button title="新对话" aria-label="新对话" onClick={newConversation} disabled={!!running}><Plus size={15} /></button>
          <button title={pinned ? "自动隐藏 AI 栏" : "固定 AI 栏"} aria-label={pinned ? "自动隐藏 AI 栏" : "固定 AI 栏"} onClick={onTogglePin}>
            {pinned ? <Pin size={15} /> : <PinOff size={15} />}
          </button>
          <button title="收起 AI 栏" aria-label="收起 AI 栏" onClick={onClose}><X size={15} /></button>
        </div>
      </header>

      <>
          {showHistory && (
            <div className="ai-history">
              <label className="ai-search"><Search size={14} /><input placeholder="搜索所有对话..." value={search} onChange={e => setSearch(e.target.value)} /></label>
              <div className="ai-history-results">
                {filteredHistory.map(item => (
                  <div key={item.id} className="ai-history-entry">
                    <button title={item.title} onClick={() => selectConversation(item)}>
                      <span>{item.title}</span><small>{new Date(item.updatedAt).toLocaleString()}</small>
                    </button>
                    <button title="删除对话" onClick={() => void removeHistory(item.id)}><Trash2 size={13} /></button>
                  </div>
                ))}
                {filteredHistory.length === 0 && <p className="ai-muted">没有匹配的对话</p>}
              </div>
            </div>
          )}
          <div className="ai-controls">
            <div className="ai-selector">
              <button className="ai-selector-button" onClick={() => setShowTargets(!showTargets)} aria-expanded={showTargets}>
                会话：{targets.map(t => t.session.name).join("、") || "无已连接会话"} <ChevronDown size={13} />
              </button>
              {showTargets && (
                <div className="ai-target-menu">
                  {connected.map(tab => (
                    <label key={tab.id}>
                      <input type="checkbox" checked={targetSet.has(tab.id)} disabled={tab.id === requiredID} onChange={() => toggleTarget(tab.id)} />
                      <span>{tab.session.name}{tab.id === requiredID ? "（当前，必选）" : ""}</span>
                    </label>
                  ))}
                  {!connected.length && <p className="ai-muted">请先连接 SSH 会话</p>}
                </div>
              )}
            </div>
            <select value={mode} disabled={submitting || !!running}
              onChange={e => setMode(e.target.value as "review" | "auto")} title="执行模式">
              <option value="review">自动审查</option>
              <option value="auto">完全自动</option>
            </select>
          </div>
          <div className="ai-execution-row">
            <label htmlFor="ai-execution-choice">操作方式</label>
            <select id="ai-execution-choice" title="AI 操作方式"
              value={execution} disabled={submitting || !!running}
              onChange={e => setExecution(e.target.value as "auto" | "independent" | "terminal")}>
              <option value="auto">自动选择（推荐）</option>
              <option value="independent">独立执行</option>
              <option value="terminal">当前终端</option>
            </select>
          </div>
          {execution === "auto" && (
            <div className="ai-terminal-ready">
              <p>自动检测执行能力：普通 SSH 优先独立执行；JumpServer 已进入资产 Shell 时使用当前终端。无法确认时不会发送命令。</p>
            </div>
          )}
          {execution === "terminal" && (
            <div className="ai-terminal-ready">
              {terminalAlternate ? (
                <p>当前终端正在运行全屏交互程序，请先退出后再使用 AI 接管。</p>
              ) : !terminalSingleTarget ? (
                <p>当前终端模式只能选择当前激活的一个 SSH 会话；多会话任务请使用独立执行。</p>
              ) : (
                <p>自动检测 Shell 是否空闲；检测不到时不会输入命令。执行期间可随时点击“接管终端”停止。</p>
              )}
            </div>
          )}
          {legacyHistoryNeedsRebind && (
            <div className="ai-session-warning" role="status">
              此历史对话没有可验证的目标服务器信息。请检查上方选择的会话，
              <button type="button" onClick={() => {
                setHistorySessionIDs([]);
                setHistoryBindings([]);
                setLegacyHistoryNeedsRebind(false);
              }}>使用当前所选会话</button>
              后才能继续执行。
            </div>
          )}
          {!legacyHistoryNeedsRebind && unavailableSessionIDs.length > 0 && (
            <div className="ai-session-warning" role="status">
              历史对话有 {unavailableSessionIDs.length} 个目标未连接，或服务器地址、账号已改变。请先恢复原连接，或
              <button type="button" onClick={() => {
                setHistorySessionIDs(old => old.filter(id => !unavailableSessionIDs.includes(id)));
                setHistoryBindings(old => old.filter(binding => !unavailableSessionIDs.includes(binding.sessionId)));
              }}>忽略未匹配目标</button>
              后继续。不会自动改用其他服务器。
            </div>
          )}
          <div className="ai-messages" ref={messagesRef} onScroll={onMessagesScroll}>
            {!current?.messages.length && <div className="ai-welcome"><Sparkles size={26}/><h3>让 AI 帮你操作服务器</h3><p>选择会话和模型，描述需要完成的任务。</p></div>}
            <AITranscript messages={current?.messages ?? []}
              execution={current?.execution === "terminal" ? "terminal" : execution} />
            {stream && <div className="ai-message ai-message--assistant ai-message--stream"><pre>{stream}</pre></div>}
            {approval && (
              <div className="ai-approval">
                <strong>AI 请求执行确认</strong>
                <p>{approval.reason || "模型判断此操作需要确认"}</p>
                <pre>{approval.command}</pre>
                <div><button onClick={() => { void api.AIApprove(approval.approvalId, false); setApproval(null); }}>拒绝</button>
                  <button className="ai-primary" onClick={() => { void api.AIApprove(approval.approvalId, true); setApproval(null); }}>允许执行</button></div>
              </div>
            )}
            {status && <p className={`ai-status ${running ? "" : "ai-status--error"}`}>
              {running && <LoaderCircle size={13} className="spin" />} {status}
            </p>}
            {error && <p className="ai-error" role="alert">{error}</p>}
          </div>
          <form className="ai-compose" onSubmit={submit}>
            <div className="ai-compose-box">
              <textarea value={message} onChange={e => setMessage(e.target.value)} rows={3}
                placeholder="描述需要 AI 执行的任务..."
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}/>
              <div className="ai-compose-actions">
                <AIModelPicker providers={providers}
                  providerID={provider?.id ?? providerID} modelID={model?.id ?? modelID}
                  onChange={chooseModel} disabled={submitting || !!running} />
                {running ? <button type="button" title="停止任务" aria-label="停止任务"
                    onClick={() => void api.AIStop(running.taskId)}><Square size={15} /></button> :
                  <button type="submit" title="发送" aria-label="发送" className="ai-primary"
                    disabled={submitting || !provider || !model || !targets.length || legacyHistoryNeedsRebind ||
                      unavailableSessionIDs.length > 0 || !message.trim() ||
                      (execution === "terminal" && !terminalAvailable)}>
                    <Send size={15} />
                  </button>}
              </div>
            </div>
          </form>
      </>
    </aside>
  );
}
