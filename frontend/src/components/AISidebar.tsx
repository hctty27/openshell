import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, ChevronDown, History, LoaderCircle, Pin, PinOff, Plus, Search, Send, Settings2, Sparkles, Square, Trash2, X } from "lucide-react";
import { api, errorText, listen } from "../bridge";
import type { AIConversation, AIProvider, AIStartResponse, Tab } from "../types";

interface Props {
  tabs: Tab[];
  active?: Tab;
  pinned: boolean;
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

const emptyProvider = (): AIProvider => ({ id: "", name: "", baseUrl: "", hasKey: false, models: [] });

export default function AISidebar({ tabs, active, pinned, onTogglePin, onClose }: Props) {
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [conversations, setConversations] = useState<AIConversation[]>([]);
  const [conversationID, setConversationID] = useState("");
  const [providerID, setProviderID] = useState("");
  const [modelID, setModelID] = useState("");
  const [mode, setMode] = useState<"review" | "auto">("review");
  const [targetIDs, setTargetIDs] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [showTargets, setShowTargets] = useState(false);
  const [showProviders, setShowProviders] = useState(false);
  const [draft, setDraft] = useState<AIProvider>(emptyProvider);
  const [draftKey, setDraftKey] = useState("");
  const [draftModels, setDraftModels] = useState("");
  const [running, setRunning] = useState<AIStartResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stream, setStream] = useState("");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const finishedTasks = useRef(new Set<string>());

  useEffect(() => {
    let valid = true;
    Promise.all([api.AIProviders(), api.AIConversations()])
      .then(([p, c]) => {
        if (!valid) return;
        setProviders(p ?? []);
        setConversations(c ?? []);
      })
      .catch(e => { if (valid) setError(errorText(e)); });
    return () => { valid = false; };
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
      setStatus(event.status === "completed" ? "任务完成" : event.status === "running" ? "正在执行" : event.detail || event.status);
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
  const targetSet = useMemo(() => new Set([...targetIDs, ...(requiredID ? [requiredID] : [])]), [targetIDs, requiredID]);
  const targets = connected.filter(tab => targetSet.has(tab.id));
  const provider = providers.find(item => item.id === providerID) ?? providers[0];
  const model = provider?.models.find(item => item.id === modelID) ?? provider?.models[0];
  const current = conversations.find(item => item.id === conversationID);
  const filteredHistory = conversations.filter(item =>
    [item.title, ...item.targetNames, ...item.messages.map(m => m.content)].join(" ").toLowerCase().includes(search.toLowerCase())
  );
  const toggleTarget = (id: string) => {
    if (id === requiredID) return;
    setTargetIDs(old => old.includes(id) ? old.filter(x => x !== id) : [...old, id]);
  };
  const selectConversation = (item: AIConversation) => {
    setConversationID(item.id);
    setProviderID(item.providerId);
    setModelID(item.modelId);
    setMode(item.mode);
    setShowHistory(false);
    setStream("");
    setStatus("");
    setError("");
  };
  const newConversation = () => {
    if (running) return;
    setConversationID("");
    setMessage("");
    setStream("");
    setStatus("");
    setError("");
    setShowHistory(false);
    setShowProviders(false);
  };
  const beginEdit = (item?: AIProvider) => {
    setDraft(item ? { ...item } : emptyProvider());
    setDraftKey("");
    setDraftModels((item?.models ?? []).map(m => m.id).join("\n"));
    setShowProviders(true);
    setShowHistory(false);
  };
  const saveProvider = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const models = [...new Set(draftModels.split(/[\r\n,]+/).map(x => x.trim()).filter(Boolean))].map(id => ({ id, name: id }));
    try {
      const saved = await api.AISaveProvider({ provider: { ...draft, models }, apiKey: draftKey.trim() });
      setProviders(old => [...old.filter(p => p.id !== saved.id), saved]);
      setProviderID(saved.id);
      setModelID(saved.models[0]?.id ?? "");
      setDraftKey("");
      setShowProviders(false);
    } catch (e) { setError(errorText(e)); }
  };
  const removeProvider = async () => {
    if (!draft.id || !window.confirm("确定删除此 API 提供商？")) return;
    try {
      await api.AIDeleteProvider(draft.id);
      setProviders(old => old.filter(p => p.id !== draft.id));
      if (providerID === draft.id) setProviderID("");
      setShowProviders(false);
    } catch (e) { setError(errorText(e)); }
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
    if (!text || !provider || !model || !targets.length || submitting || running) return;
    setError("");
    setStatus("正在执行");
    setStream("");
    setSubmitting(true);
    try {
      const started = await api.AIStart({
        conversationId: conversationID, providerId: provider.id, modelId: model.id,
        mode, text, targets: targets.map(tab => tab.ref!),
      });
      if (!finishedTasks.current.has(started.taskId)) setRunning(started);
      setConversationID(started.conversationId);
      setMessage("");
    } catch (e) { setError(errorText(e)); setStatus(""); }
    finally { setSubmitting(false); }
  };

  return (
    <aside className="ai-panel" aria-label="AI 助手">
      <header className="ai-header">
        <strong><Sparkles size={15} /> AI 助手</strong>
        <div className="ai-header-actions">
          <button title="全局对话记录" aria-label="全局对话记录" onClick={() => { setShowHistory(!showHistory); setShowProviders(false); }}><History size={15} /></button>
          <button title="新对话" aria-label="新对话" onClick={newConversation} disabled={!!running}><Plus size={15} /></button>
          <button title="模型设置" aria-label="模型设置" onClick={() => showProviders ? setShowProviders(false) : beginEdit(provider)}><Settings2 size={15} /></button>
          <button title={pinned ? "自动隐藏 AI 栏" : "固定 AI 栏"} aria-label={pinned ? "自动隐藏 AI 栏" : "固定 AI 栏"} onClick={onTogglePin}>
            {pinned ? <Pin size={15} /> : <PinOff size={15} />}
          </button>
          <button title="收起 AI 栏" aria-label="收起 AI 栏" onClick={onClose}><X size={15} /></button>
        </div>
      </header>

      {showProviders ? (
        <div className="ai-settings">
          <div className="ai-settings-list">
            {providers.map(p => (
              <button key={p.id} className={draft.id === p.id ? "selected" : ""} onClick={() => beginEdit(p)}>{p.name}</button>
            ))}
            <button onClick={() => beginEdit()}><Plus size={13} /> 添加 API</button>
          </div>
          <form onSubmit={saveProvider}>
            <label>API 名称<input value={draft.name} onChange={e => setDraft(p => ({ ...p, name: e.target.value }))} placeholder="My API" required /></label>
            <label>Base URL<input value={draft.baseUrl} onChange={e => setDraft(p => ({ ...p, baseUrl: e.target.value }))} placeholder="https://example.com/v1" required /></label>
            <label>API Key<input type="password" autoComplete="off" value={draftKey} onChange={e => setDraftKey(e.target.value)} placeholder={draft.hasKey ? "留空保持原密钥" : "输入 API Key"} /></label>
            <label>模型 ID（每行一个）<textarea rows={5} value={draftModels} onChange={e => setDraftModels(e.target.value)} placeholder={"model-1\nmodel-2"} required /></label>
            <div className="ai-form-actions">
              {draft.id && <button type="button" className="ai-danger" onClick={() => void removeProvider()}><Trash2 size={13} /> 删除</button>}
              <button type="button" onClick={() => setShowProviders(false)}>取消</button>
              <button className="ai-primary" type="submit"><Check size={13} /> 保存</button>
            </div>
          </form>
        </div>
      ) : (
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
            <select value={mode} onChange={e => setMode(e.target.value as "review" | "auto")} title="执行模式">
              <option value="review">自动审查</option>
              <option value="auto">完全自动</option>
            </select>
          </div>
          <div className="ai-messages">
            {!current?.messages.length && <div className="ai-welcome"><Sparkles size={26}/><h3>让 AI 帮你操作服务器</h3><p>选择会话和模型，描述需要完成的任务。</p></div>}
            {current?.messages.filter(m => m.role !== "system").map((m, i) => (
              <div key={i} className={`ai-message ai-message--${m.role}`}>
                <span className="ai-message-role">{m.role === "user" ? "你" : m.role === "assistant" ? "AI" : "工具结果"}</span>
                {m.content && <pre>{m.content}</pre>}
                {m.tool_calls?.map(call => <div className="ai-tool-call" key={call.id}>执行工具：{call.function.name}<pre>{call.function.arguments}</pre></div>)}
              </div>
            ))}
            {stream && <div className="ai-message ai-message--assistant"><span className="ai-message-role">AI · 输出中</span><pre>{stream}</pre></div>}
            {approval && (
              <div className="ai-approval">
                <strong>AI 请求执行确认</strong>
                <p>{approval.reason || "模型判断此操作需要确认"}</p>
                <pre>{approval.command}</pre>
                <div><button onClick={() => { void api.AIApprove(approval.approvalId, false); setApproval(null); }}>拒绝</button>
                  <button className="ai-primary" onClick={() => { void api.AIApprove(approval.approvalId, true); setApproval(null); }}>允许执行</button></div>
              </div>
            )}
            {status && <p className="ai-status">{running && <LoaderCircle size={13} className="spin" />} {status}</p>}
            {error && <p className="ai-error" role="alert">{error}</p>}
          </div>
          <form className="ai-compose" onSubmit={submit}>
            <textarea value={message} onChange={e => setMessage(e.target.value)} rows={3}
              placeholder="描述需要 AI 执行的任务..."
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}/>
            <div className="ai-compose-actions">
              <select value={provider?.id ?? ""} onChange={e => { setProviderID(e.target.value); setModelID(""); }} aria-label="API 提供商">
                {!providers.length && <option value="">请配置 API</option>}
                {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select value={model?.id ?? ""} onChange={e => setModelID(e.target.value)} aria-label="模型">
                {(provider?.models ?? []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              {running ? <button type="button" title="停止任务" onClick={() => void api.AIStop(running.taskId)}><Square size={15} /></button> :
                <button type="submit" title="发送" className="ai-primary" disabled={submitting || !provider || !targets.length || !message.trim()}><Send size={15} /></button>}
            </div>
          </form>
        </>
      )}
    </aside>
  );
}
