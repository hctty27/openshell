import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, History, LoaderCircle, MoreHorizontal, Pin, PinOff, Plus, Search, Send, Sparkles, Square, Trash2 } from "lucide-react";
import { api, errorText, listen } from "../bridge";
import type { AIConversation, AIProvider, AIStartResponse, AITargetBinding, Tab } from "../types";
import AIModelPicker from "./AIModelPicker";
import AITranscript from "./AITranscript";
import { AI_PROVIDERS_CHANGED } from "../features/ai/providerEvents";
import { readLastModel, saveLastModel } from "../features/ai/modelSelection";
import { t } from "../i18n";
import { decodeAppError } from "../i18n/errors";
import { useTranslation } from "react-i18next";

interface Props {
  tabs: Tab[];
  active?: Tab;
  pinned: boolean;
  isOpen: boolean;
  terminalAlternate?: boolean;
  onTogglePin(): void;
}

interface Approval {
  taskId: string;
  approvalId: string;
  command: string;
  reason: string;
  tabId: string;
}

export default function AISidebar({ tabs, active, pinned, isOpen, terminalAlternate = false, onTogglePin }: Props) {
  useTranslation("ai");
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
  const [showOptions, setShowOptions] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
    if (!showOptions) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!optionsRef.current?.contains(event.target as Node)) setShowOptions(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowOptions(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [showOptions]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(148, Math.max(44, textarea.scrollHeight))}px`;
  }, [message]);

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
        event.status === "running" ? "running" :
        event.detail || (event.status === "cancelled" ? t("ai:taskCancelled") : t("ai:executionFailed")));
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
  const primaryTarget = targets.find(tab => tab.id === requiredID) ?? targets[0];
  const selectedTargetLabel = primaryTarget
    ? `${primaryTarget.session.name}${targets.length > 1 ? ` +${targets.length - 1}` : ""}`
    : t("ai:noConnectedSessions");
  const selectedTargetTitle = `${t("ai:sessionsLabel")}${targets.map(tab => tab.session.name).join("、") || t("ai:noConnectedSessions")}`;
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
    setShowOptions(false);
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
    setShowOptions(false);
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
    setStatus("running");
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
    <aside className="ai-panel" aria-label={t("ai:assistant")} aria-hidden={!isOpen}>
      <header className="ai-header">
        <strong><Sparkles size={15} /> {t("ai:assistant")}</strong>
        <div className="ai-header-actions">
          <button title={t("ai:allConversations")} aria-label={t("ai:allConversations")} onClick={() => setShowHistory(!showHistory)}><History size={15} /></button>
          <button type="button" title={t("ai:newConversation")} aria-label={t("ai:newConversation")} onClick={newConversation} disabled={!!running}><Plus size={15} /></button>
          <div className="ai-header-options" ref={optionsRef}>
            <button type="button" title={t("ai:moreOptions")} aria-label={t("ai:executionStrategy")}
              aria-expanded={showOptions} aria-controls="ai-execution-options"
              onClick={() => { setShowOptions(value => !value); setShowHistory(false); }}>
              <MoreHorizontal size={16} />
            </button>
            {showOptions && (
              <div id="ai-execution-options" className="ai-options-menu">
                <label htmlFor="ai-execution-choice">{t("ai:operationMethod")}</label>
                <select id="ai-execution-choice" title={t("ai:executionStrategy")}
                  value={execution} disabled={submitting || !!running}
                  onChange={e => setExecution(e.target.value as "auto" | "independent" | "terminal")}>
                  <option value="auto">{t("ai:autoRecommended")}</option>
                  <option value="independent">{t("ai:independent")}</option>
                  <option value="terminal">{t("ai:currentTerminal")}</option>
                </select>
                <p className="ai-options-hint">
                  {execution === "auto" ? t("ai:autoCapabilityHelp") :
                    execution === "terminal" ? terminalAlternate ? t("ai:interactiveProgram") :
                      !terminalSingleTarget ? t("ai:terminalOnlyOne") : t("ai:terminalIdleHelp") :
                      t("ai:independentHelp")}
                </p>
              </div>
            )}
          </div>
          <button title={t(pinned ? "ai:autoHideSidebar" : "ai:pinSidebar")} aria-label={t(pinned ? "ai:autoHideSidebar" : "ai:pinSidebar")} onClick={onTogglePin}>
            {pinned ? <Pin size={15} /> : <PinOff size={15} />}
          </button>
        </div>
      </header>

      <>
          {showHistory && (
            <div className="ai-history">
              <label className="ai-search"><Search size={14} /><input placeholder={t("ai:searchConversations")} value={search} onChange={e => setSearch(e.target.value)} /></label>
              <div className="ai-history-results">
                {filteredHistory.map(item => (
                  <div key={item.id} className="ai-history-entry">
                    <button title={item.title} onClick={() => selectConversation(item)}>
                      <span>{item.title}</span><small>{new Date(item.updatedAt).toLocaleString()}</small>
                    </button>
                    <button title={t("ai:deleteConversation")} onClick={() => void removeHistory(item.id)}><Trash2 size={13} /></button>
                  </div>
                ))}
                {filteredHistory.length === 0 && <p className="ai-muted">{t("ai:noMatchingConversations")}</p>}
              </div>
            </div>
          )}
          <div className="ai-controls">
            <div className="ai-selector">
              <button type="button" className="ai-selector-button" onClick={() => setShowTargets(!showTargets)}
                aria-expanded={showTargets}
                title={selectedTargetTitle} aria-label={selectedTargetTitle}>
                <span className="ai-selector-label">{t("ai:sessionsLabel")}{selectedTargetLabel}</span>
                <ChevronDown size={13} aria-hidden="true" />
              </button>
              {showTargets && (
                <div className="ai-target-menu">
                  {connected.map(tab => (
                    <label key={tab.id}>
                      <input type="checkbox" checked={targetSet.has(tab.id)} disabled={tab.id === requiredID} onChange={() => toggleTarget(tab.id)} />
                      <span>{tab.session.name}{tab.id === requiredID ? t("ai:currentRequired") : ""}</span>
                    </label>
                  ))}
                  {!connected.length && <p className="ai-muted">{t("ai:connectSshFirst")}</p>}
                </div>
              )}
            </div>
            <select value={mode} disabled={submitting || !!running}
              onChange={e => setMode(e.target.value as "review" | "auto")}
              aria-label={t("ai:executionMode")} title={mode === "review" ? t("ai:reviewMode") : t("ai:automaticMode")}>
              <option value="review">{t("ai:reviewModeShort")}</option>
              <option value="auto">{t("ai:automaticModeShort")}</option>
            </select>
          </div>
          {execution === "terminal" && (terminalAlternate || !terminalSingleTarget) && (
            <div className="ai-session-warning ai-execution-warning" role="status">
              {terminalAlternate ? t("ai:interactiveProgram") : t("ai:terminalOnlyOne")}
            </div>
          )}
          {legacyHistoryNeedsRebind && (
            <div className="ai-session-warning" role="status">
              {t("ai:legacyWarningBefore")}
              <button type="button" onClick={() => {
                setHistorySessionIDs([]);
                setHistoryBindings([]);
                setLegacyHistoryNeedsRebind(false);
              }}>{t("ai:legacyUseSelected")}</button>
              {t("ai:legacyWarningAfter")}
            </div>
          )}
          {!legacyHistoryNeedsRebind && unavailableSessionIDs.length > 0 && (
            <div className="ai-session-warning" role="status">
              {t("ai:unavailableHistoryBefore", { count: unavailableSessionIDs.length })}
              <button type="button" onClick={() => {
                setHistorySessionIDs(old => old.filter(id => !unavailableSessionIDs.includes(id)));
                setHistoryBindings(old => old.filter(binding => !unavailableSessionIDs.includes(binding.sessionId)));
              }}>{t("ai:ignoreUnmatchedTargets")}</button>
              {t("ai:unavailableHistoryAfter")}
            </div>
          )}
          <div className="ai-messages" ref={messagesRef} onScroll={onMessagesScroll}>
            {!current?.messages.length && <div className="ai-welcome"><Sparkles size={26}/><h3>{t("ai:welcomeTitle")}</h3><p>{t("ai:welcomeDescription")}</p></div>}
            <AITranscript messages={current?.messages ?? []}
              execution={current?.execution === "terminal" ? "terminal" : "independent"} />
            {stream && <div className="ai-message ai-message--assistant ai-message--stream"><pre>{stream}</pre></div>}
            {approval && (
              <div className="ai-approval">
                <strong>{t("ai:approvalTitle")}</strong>
                <p>{approval.reason || t("ai:approvalReason")}</p>
                <pre>{approval.command}</pre>
                <div><button onClick={() => { void api.AIApprove(approval.approvalId, false); setApproval(null); }}>{t("ai:reject")}</button>
                  <button className="ai-primary" onClick={() => { void api.AIApprove(approval.approvalId, true); setApproval(null); }}>{t("ai:allowExecution")}</button></div>
              </div>
            )}
            {status && <p className={`ai-status ${running ? "" : "ai-status--error"}`}>
              {running && <LoaderCircle size={13} className="spin" />} {status === "running" ? t("ai:running") : decodeAppError(status) ? errorText(status) : status}
            </p>}
            {error && <p className="ai-error" role="alert">{error}</p>}
          </div>
          <form className="ai-compose" onSubmit={submit}>
            <div className="ai-compose-box">
              <textarea ref={textareaRef} value={message} onChange={e => setMessage(e.target.value)} rows={2}
                placeholder={t("ai:messagePlaceholder")}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}/>
              <div className="ai-compose-actions">
                <AIModelPicker providers={providers}
                  providerID={provider?.id ?? providerID} modelID={model?.id ?? modelID}
                  onChange={chooseModel} disabled={submitting || !!running} />
                {running ? <button type="button" title={t("ai:stopTask")} aria-label={t("ai:stopTask")}
                    onClick={() => void api.AIStop(running.taskId)}><Square size={15} /></button> :
                  <button type="submit" title={t("ai:send")} aria-label={t("ai:send")} className="ai-primary"
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
