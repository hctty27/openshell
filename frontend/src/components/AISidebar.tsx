import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { BatchedTextBuffer } from "../features/performance/batchedTextBuffer";
import { ChevronDown, History, LoaderCircle, Pin, PinOff, Plus, Server, Sparkles, Square } from "lucide-react";
import { api, errorText, listen } from "../bridge";
import type { AIConversation, AIProvider, AIStartResponse, AIContextStats, AITargetBinding, Tab } from "../types";
import AIModelPicker from "./AIModelPicker";
import AIDropdownSurface from "./AIDropdownSurface";
import AISendControl from "./AISendControl";
import AIContextIndicator from "./AIContextIndicator";
import AIHistoryPopover from "./AIHistoryPopover";
import { AI_RUNTIME_SETTINGS_CHANGED, defaultAIRuntimeSettings } from "./AIBehaviorSettings";
import type { AIRuntimeSettings } from "../types";
import { readAIExecutionMode, saveAIExecutionMode, type AIExecutionMode } from "../features/ai/executionModePreference";
import AITranscript from "./AITranscript";
import { belongsToConversationScope } from "../features/ai/conversationScope";
import { AI_PROVIDERS_CHANGED } from "../features/ai/providerEvents";
import { readLastModel, saveLastModel } from "../features/ai/modelSelection";
import { resolveAIModelSelection } from "../features/ai/modelFallback";
import { t } from "../i18n";
import { decodeAppError } from "../i18n/errors";
import { useTranslation } from "react-i18next";

interface Props {
  tabs: Tab[];
  active?: Tab;
  pinned: boolean;
  isOpen: boolean;
  terminalAlternate?: boolean;
  terminalScopeId?: string;
  onTogglePin(): void;
  onOpenAISettings?(): void;
}

interface Approval {
  taskId: string;
  approvalId: string;
  command: string;
  reason: string;
  tabId: string;
}

export default function AISidebar({ tabs, active, pinned, isOpen, terminalAlternate = false, terminalScopeId, onTogglePin, onOpenAISettings }: Props) {
  useTranslation("ai");
  const isTerminal = terminalScopeId !== undefined;
  const execution = isTerminal ? "terminal" : "independent";
  const lastModelRef = useRef(readLastModel());
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [conversations, setConversations] = useState<AIConversation[]>([]);
  const [conversationID, setConversationID] = useState("");
  const [providerID, setProviderID] = useState(lastModelRef.current.providerId);
  const [modelID, setModelID] = useState(lastModelRef.current.modelId);
  const [mode, setMode] = useState<AIExecutionMode>(() => readAIExecutionMode(isTerminal));
  const [targetIDs, setTargetIDs] = useState<string[]>([]);
  const [historySessionIDs, setHistorySessionIDs] = useState<string[]>([]);
  const [historyBindings, setHistoryBindings] = useState<AITargetBinding[]>([]);
  const [legacyHistoryNeedsRebind, setLegacyHistoryNeedsRebind] = useState(false);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [showTargets, setShowTargets] = useState(false);
  const historyTriggerRef = useRef<HTMLButtonElement>(null);
  const targetTriggerRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [running, setRunning] = useState<AIStartResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stream, setStream] = useState("");
  const streamBatcher = useRef<BatchedTextBuffer | null>(null);
  const clearStream = () => {
    streamBatcher.current?.clear();
    setStream("");
  };
  const [approval, setApproval] = useState<Approval | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [contextInfo, setContextInfo] = useState<AIContextStats | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const modelSaveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [compacting, setCompacting] = useState(false);
  const [runtimeSettings, setRuntimeSettings] = useState<AIRuntimeSettings>(defaultAIRuntimeSettings);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (typeof api.AIRuntimeSettings !== "function") return;
      void api.AIRuntimeSettings()
        .then(next => { if (active) setRuntimeSettings(next); })
        .catch(() => {});
    };
    refresh();
    window.addEventListener(AI_RUNTIME_SETTINGS_CHANGED, refresh);
    return () => {
      active = false;
      window.removeEventListener(AI_RUNTIME_SETTINGS_CHANGED, refresh);
    };
  }, []);
  const finishedTasks = useRef(new Set<string>());
  const activeTaskRef = useRef("");
  const currentConversationRef = useRef("");
  currentConversationRef.current = conversationID;
  const messagesRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const changeMode = (next: AIExecutionMode) => {
    setMode(next);
    saveAIExecutionMode(isTerminal, next);
  };

  useEffect(() => {
    if (!isOpen) {
      setShowTargets(false);
      setShowHistory(false);
    }
  }, [isOpen]);

  const onMessagesScroll = () => {
    const node = messagesRef.current;
    if (!node) return;
    // 用户向上查看旧消息时停止跟随；回到底部时自动恢复。
    followOutputRef.current =
      node.scrollHeight - node.scrollTop - node.clientHeight <= 72;
  };

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
        setConversations((c ?? []).filter(item => belongsToConversationScope(item, terminalScopeId)));
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
  }, [terminalScopeId]);

  useEffect(() => {
    const buffer = new BatchedTextBuffer(delta => setStream(old => old + delta));
    streamBatcher.current = buffer;
    const offConversation = listen("ai:conversation", (next: AIConversation) => {
      if (!belongsToConversationScope(next, terminalScopeId)) return;
      setConversations(old => [next, ...old.filter(item => item.id !== next.id)]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      if (next.id === currentConversationRef.current) clearStream();
    });
    const offDelta = listen("ai:delta", (event: { taskId: string; text: string }) => {
      if (activeTaskRef.current && event.taskId === activeTaskRef.current) buffer.append(event.text);
    });
    const offState = listen("ai:state", (event: { taskId: string; status: string; detail: string }) => {
      if (!activeTaskRef.current || event.taskId !== activeTaskRef.current) return;
      setStatus(event.status === "completed" ? "" :
        event.status === "running" ? "running" :
        event.detail || (event.status === "cancelled" ? t("ai:taskCancelled") : t("ai:executionFailed")));
      if (event.status !== "running") {
        finishedTasks.current.add(event.taskId);
        activeTaskRef.current = "";
        setRunning(old => old?.taskId === event.taskId ? null : old);
        clearStream();
        setApproval(null);
      }
    });
    const offContext = listen("ai:context", (event: {conversationId: string; status: string; context?: AIContextStats}) => {
      if (event.conversationId !== currentConversationRef.current) return;
      setCompacting(event.status === "compacting");
      if (event.context) {
        setContextInfo(event.context);
        setContextLoading(false);
      }
    });
    const offApproval = listen("ai:approval", (event: Approval) => {
      if (activeTaskRef.current && event.taskId === activeTaskRef.current) setApproval(event);
    });
    return () => {
      offConversation(); offDelta(); offState(); offApproval(); offContext();
      buffer.dispose();
      if (streamBatcher.current === buffer) streamBatcher.current = null;
    };
  }, [terminalScopeId]);

  const connected = tabs.filter(tab => tab.status === "connected" && tab.ref && (!isTerminal || tab.id === active?.id));
  useEffect(() => {
    if (!connected.length) setShowTargets(false);
  }, [connected.length]);
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
  const resolvedSelection = resolveAIModelSelection(
    providers,
    { providerId: providerID, modelId: modelID },
    lastModelRef.current,
  );
  const provider = providers.find(item => item.id === resolvedSelection?.providerId);
  const model = provider?.models.find(item => item.id === resolvedSelection?.modelId);
  const current = conversations.find(item => item.id === conversationID && belongsToConversationScope(item, terminalScopeId));

  useEffect(() => {
    if (!resolvedSelection || (providerID === resolvedSelection.providerId && modelID === resolvedSelection.modelId)) return;
    setProviderID(resolvedSelection.providerId);
    setModelID(resolvedSelection.modelId);
    lastModelRef.current = resolvedSelection;
    saveLastModel(resolvedSelection);
  }, [providerID, modelID, resolvedSelection?.providerId, resolvedSelection?.modelId]);

  useEffect(() => {
    if (!conversationID || !current || !provider || !model) return;
    if (current.providerId === provider.id && current.modelId === model.id) return;
    const conversationId = conversationID;
    const nextProviderId = provider.id;
    const nextModelId = model.id;
    modelSaveQueue.current = modelSaveQueue.current
      .catch(() => {})
      .then(() => api.AISetConversationModel(conversationId, nextProviderId, nextModelId))
      .catch(error => {
        if (currentConversationRef.current === conversationId) setError(errorText(error));
      });
  }, [conversationID, current?.providerId, current?.modelId, provider?.id, model?.id]);
  const emptyContextStats: AIContextStats = {
    window: model?.contextWindow || 32768,
    estimatedTokens: 0,
    lastPromptTokens: 0,
    compactionCount: 0,
    isEstimate: true,
  };
  useEffect(() => {
    if (!conversationID || !provider?.id || !model?.id || typeof api.AIContext !== "function") {
      setContextInfo(null);
      setContextLoading(false);
      return;
    }
    let active = true;
    setContextInfo(null);
    setContextLoading(true);
    void api.AIContext(conversationID, provider.id, model.id)
      .then(result => { if (active) setContextInfo(result); })
      .catch(() => { if (active) setContextInfo(null); })
      .finally(() => { if (active) setContextLoading(false); });
    return () => { active = false; };
  }, [conversationID, provider?.id, model?.id, current?.messages.length, current?.compactionCount]);
  const compactHistory = async () => {
    if (!conversationID || running || submitting || compacting) return;
    setError("");
    setCompacting(true);
    try {
      await api.AICompactConversation(conversationID);
      if (provider && model) setContextInfo(await api.AIContext(conversationID, provider.id, model.id));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setCompacting(false);
    }
  };
  useLayoutEffect(() => {
    const node = messagesRef.current;
    if (!isOpen || !node || !followOutputRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [isOpen, conversationID, current?.messages, stream, status, error, approval]);
  const filteredHistory = conversations.filter(item => belongsToConversationScope(item, terminalScopeId)).filter(item =>
    [item.title, ...item.targetNames, ...item.messages.map(m => m.content)].join(" ").toLowerCase().includes(search.toLowerCase())
  );
  useEffect(() => {
    if (!showTargets) return;
    const firstAvailable = document.querySelector<HTMLInputElement>(".ai-target-menu input[type=checkbox]:not(:disabled)");
    firstAvailable?.focus();
  }, [showTargets]);

  const onTargetsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setShowTargets(false);
      targetTriggerRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(event.key)) return;
    const inputs = Array.from(event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not(:disabled)'));
    if (!inputs.length) return;
    const current = inputs.indexOf(document.activeElement as HTMLInputElement);
    if (event.key === "Enter") {
      if (current >= 0) {
        event.preventDefault();
        inputs[current].click();
      }
      return;
    }
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? inputs.length - 1 :
      (current + (event.key === "ArrowDown" ? 1 : -1) + inputs.length) % inputs.length;
    inputs[next]?.focus();
  };

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
    activeTaskRef.current = "";
    setContextInfo(null);
    setContextLoading(true);
    setConversationID(item.id);
    setProviderID(item.providerId);
    setModelID(item.modelId);
    setMode(item.mode);
    setShowHistory(false);
    setShowTargets(false);
    clearStream();
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
    activeTaskRef.current = "";
    setContextInfo(null);
    setContextLoading(false);
    setConversationID("");
    setProviderID(lastModelRef.current.providerId);
    setModelID(lastModelRef.current.modelId);
    setMessage("");
    clearStream();
    setStatus("");
    setError("");
    setShowHistory(false);
    setShowTargets(false);
  };
  const chooseModel = (nextProviderID: string, nextModelID: string) => {
    setContextInfo(null);
    setContextLoading(Boolean(conversationID));
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
      (isTerminal && !terminalAvailable)) return;
    followOutputRef.current = true;
    setError("");
    setStatus("running");
    clearStream();
    setSubmitting(true);
    try {
      await modelSaveQueue.current;
      const started = await api.AIStart({
        conversationId: conversationID, providerId: provider.id, modelId: model.id,
        mode, execution, scopeId: terminalScopeId ?? "", text, targets: targets.map(tab => tab.ref!),
      });
      activeTaskRef.current = started.taskId;
      currentConversationRef.current = started.conversationId;
      if (!finishedTasks.current.has(started.taskId)) setRunning(started);
      setConversationID(started.conversationId);
      setMessage("");
    } catch (e) { setError(errorText(e)); setStatus(""); }
    finally { setSubmitting(false); }
  };

  return (
    <aside id={isTerminal ? undefined : "global-ai-panel"} className="ai-panel"
      aria-label={t(isTerminal ? "ai:terminalAssistant" : "ai:assistant")} aria-hidden={!isOpen}>
      <header className={`ai-header panel-header${isTerminal ? " workspace-panel-header" : ""}`}>
        <strong className="panel-header-title" title={isTerminal ? `${active?.session.name ?? ""} · ${active?.session.username ?? ""}@${active?.session.host ?? ""}` : undefined}>{isTerminal ? <span className="workspace-panel-dot" aria-hidden="true" /> : <Sparkles size={15} />}<span>{t(isTerminal ? "ai:terminalAssistant" : "ai:assistant")}</span></strong>
        <div className="ai-header-actions panel-header-actions">
          <AIContextIndicator
            stats={conversationID ? contextInfo : emptyContextStats}
            loading={!!conversationID && contextLoading}
            unavailable={!!conversationID && !contextLoading && !contextInfo}
            compacting={compacting} disabled={!conversationID || !contextInfo || !!running || submitting}
             disabledReason={!conversationID ? t("ai:contextNoHistory") : t("ai:contextCompactBusy")}
            autoCompact={runtimeSettings.autoCompact} compactThreshold={runtimeSettings.compactThreshold}
            historyOpen={showHistory} onOpen={() => setShowHistory(false)}
            onCompact={() => void compactHistory()} />
          <button type="button" ref={historyTriggerRef}
            title={t(isTerminal ? "ai:terminalConversations" : "ai:allConversations")}
            aria-label={t(isTerminal ? "ai:terminalConversations" : "ai:allConversations")}
            aria-haspopup="dialog" aria-expanded={showHistory}
            onClick={() => {
              if (!showHistory) setSearch("");
              setShowHistory(!showHistory);
            }}>
            <History size={15} />
          </button>
          <button type="button" title={t("ai:newConversation")} aria-label={t("ai:newConversation")} onClick={newConversation} disabled={!!running}><Plus size={15} /></button>
          {!isTerminal && (
            <button type="button" className="sidebar-pin-toggle" aria-pressed={pinned}
              title={t(pinned ? "ai:autoHideSidebar" : "ai:pinSidebar")}
              aria-label={t(pinned ? "ai:autoHideSidebar" : "ai:pinSidebar")} onClick={onTogglePin}>
              {pinned ? <Pin size={15} /> : <PinOff size={15} />}
            </button>
          )}
        </div>
      </header>

      <>
          {showHistory && <AIHistoryPopover
            items={filteredHistory} selectedID={conversationID} query={search} onQueryChange={setSearch}
            title={t(isTerminal ? "ai:terminalConversations" : "ai:allConversations")}
            searchPlaceholder={t(isTerminal ? "ai:searchTerminalConversations" : "ai:searchConversations")}
            terminal={isTerminal} triggerRef={historyTriggerRef}
            onSelect={selectConversation} onDelete={id => void removeHistory(id)}
            onClose={() => setShowHistory(false)} />}
          {isTerminal && (terminalAlternate || !terminalSingleTarget) && (
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
                <div className={"ai-compose-config" + (!isTerminal ? " ai-compose-config--with-target" : "")}>
                  <AIModelPicker providers={providers}
                    providerID={provider?.id ?? providerID} modelID={model?.id ?? modelID}
                    onChange={chooseModel} onConfigure={onOpenAISettings} disabled={submitting || !!running} />
                  {!isTerminal && (
                    <div className="ai-selector ai-compose-target">
              <button ref={targetTriggerRef} type="button" className="ai-selector-button"
                aria-disabled={!connected.length}
                onClick={() => { if (connected.length) setShowTargets(value => !value); }}
                  onKeyDown={event => {
                    if (!connected.length) return;
                    if (event.key === "Escape" && showTargets) {
                      event.preventDefault();
                      event.stopPropagation();
                      setShowTargets(false);
                    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      setShowTargets(true);
                    }
                  }}
                aria-expanded={connected.length > 0 && showTargets}
                title={connected.length ? selectedTargetTitle : t("ai:connectSshFirst")} aria-label={selectedTargetTitle}>
                <Server size={13} aria-hidden="true" />
                <span className="ai-selector-label">{selectedTargetLabel}</span>
                {connected.length > 0 && <ChevronDown size={13} aria-hidden="true" />}
              </button>
              <AIDropdownSurface open={showTargets && connected.length > 0} anchorRef={targetTriggerRef}
                onDismiss={() => setShowTargets(false)} align="end" matchAnchorWidth maxHeight={260}>
                <div className="ai-target-menu" role="group" aria-label={t("ai:sessionsLabel")}
                  onKeyDown={onTargetsKeyDown}>
                  {connected.map(tab => (
                    <label key={tab.id}>
                      <input type="checkbox" checked={targetSet.has(tab.id)} disabled={tab.id === requiredID} onChange={() => toggleTarget(tab.id)} />
                      <span title={tab.session.name}>{tab.session.name}</span>
                    </label>
                  ))}
                </div>
              </AIDropdownSurface>
            </div>
                  )}
                </div>
                {running ? <button type="button" title={t("ai:stopTask")} aria-label={t("ai:stopTask")}
                    className="ai-stop-button" onClick={() => void api.AIStop(running.taskId)}><Square size={15} /></button> :
                  <AISendControl mode={mode} onModeChange={changeMode} modeDisabled={submitting}
                    disabled={submitting || !provider || !model || !targets.length || legacyHistoryNeedsRebind ||
                      unavailableSessionIDs.length > 0 || !message.trim() ||
                      (isTerminal && !terminalAvailable)} />}

              </div>
            </div>
          </form>
      </>
    </aside>
  );
}
