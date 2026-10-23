import { reasonText, decodeAppError } from "./i18n/errors";
import { message, renderMessage, type DisplayText } from "./i18n/message";
import { t as tr } from "./i18n";
import { useTranslation } from "react-i18next";
import { initializeI18n, i18n } from "./i18n";
import { normalizeLanguage, type Language } from "./i18n/languages";
import { useState, useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  Terminal,
  Plus,
  X,
  PanelRightOpen,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Unplug,
  Copy,
  Sparkles,
  ArrowRight,
  Server,
  ShieldCheck,
  LoaderCircle,
  AlertCircle,
  Check,
  FolderOpen,
  Search,
  Columns2,
  Rows2,
} from "lucide-react";
import { api, desktop, listen, errorText } from "./bridge";
import { OnFileDrop, OnFileDropOff } from "../wailsjs/runtime/runtime";
import { normalizeTerminalTheme, resolveTerminalTheme } from "./terminalThemes";
import type {
  Session,
  Group,
  APIProfile,
  AppState,
  Tab,
  Ref,
  HostChallenge,
  ChatMessage,
  SessionRequest,
  ChatRequest,
  ChatMode,
  AutoEvent,
  Theme,
  QuickCommand,
  QuickCommandLayout,
  XshellImportPreview,
  SFTPTask,
} from "./types";
import SessionTree from "./components/SessionTree";
import SessionPicker from "./components/SessionPicker";
import XshellImportDialog from "./components/XshellImportDialog";
import SettingsDialog from "./components/SettingsDialog";
import TerminalPane from "./components/TerminalPane";
import SFTPView from "./components/SFTPView";
import TransferDock from "./components/TransferDock";
import ZmodemProgressDialog from "./components/ZmodemProgressDialog";
import AISidebar from "./components/AISidebar";
import { useConversations } from "./useConversations";
import { toChatMessages } from "./conversations";
import QuickCommandBar from "./components/QuickCommandBar";
import QuickCommandManager from "./components/QuickCommandManager";
import { quickCommandTerminalInput } from "./quickCommands";
import { DialogProvider, useDialogs } from "./components/DialogProvider";
const APP_VERSION = import.meta.env.VITE_APP_VERSION || "0.1.53";
const initial: AppState = {
  sessions: [],
  groups: [],
  profiles: [],
  fontSize: "14",
  activeProfile: "",
  version: APP_VERSION,
};
const id = () => crypto.randomUUID();
export default function App() {
  useTranslation();
  const [data, setData] = useState<AppState | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setFailed(false);
    (async () => {
      let loaded: AppState;
      try {
        loaded = await api.State();
      } catch {
        if (desktop) {
          if (current) setFailed(true);
          return;
        }
        loaded = initial;
      }
      if (!current) return;
      await initializeI18n(normalizeLanguage(loaded.language));
      if (current) setData(loaded);
    })().catch(() => {
      if (current) setFailed(true);
    });
    return () => {
      current = false;
    };
  }, [attempt]);
  if (!data)
    return (
      <main className="startup-screen" role="status">
        {failed ? (
          <>
            <p>{tr("common:unableToLoadWorkspace")}</p>
            <button onClick={() => setAttempt((n) => n + 1)}>{tr("common:retry")}</button>
          </>
        ) : (
          tr("common:loadingOpenShell")
        )}
      </main>
    );
  return (
    <DialogProvider>
      <Workspace initialState={data} />
    </DialogProvider>
  );
}
function Workspace({ initialState }: { initialState: AppState }) {
  useTranslation();
  const languageLock = useRef(false);
  const [languageSaving, setLanguageSaving] = useState(false);
  const [language, setLanguage] = useState<Language>(
    normalizeLanguage(initialState.language),
  );
  const changeLanguage = async (next: Language) => {
    if (languageLock.current || next === language) return;
    languageLock.current = true;
    setLanguageSaving(true);
    try {
      await api.SavePreference("language", next);
      await i18n.changeLanguage(next);
      setLanguage(next);
      setState((old) => ({ ...old, language: next }));
    } finally {
      languageLock.current = false;
      setLanguageSaving(false);
    }
  };
  const dialogs = useDialogs();
  const [state, setState] = useState(initialState),
    [tabs, setTabs] = useState<Tab[]>([]),
    [activeID, setActiveID] = useState(""),
    [showAI, setShowAI] = useState(true),
    [showSessions, setShowSessions] = useState(true),
    [showSessionPicker, setShowSessionPicker] = useState(false),
    [xshellPreview, setXshellPreview] = useState<XshellImportPreview | null>(null),
    [fontSize, setFontSize] = useState(
      Math.max(11, Math.min(24, Number(initialState.fontSize) || 14)),
    ),
    [theme, setTheme] = useState<Theme>(
      initialState.theme === "light" ? "light" : "dark",
    ),
    [terminalTheme, setTerminalTheme] = useState(
      normalizeTerminalTheme(initialState.terminalTheme),
    ),
    [quickCommandLayout, setQuickCommandLayout] = useState<QuickCommandLayout>(
      initialState.quickCommandLayout === "multi" ? "multi" : "single",
    ),
    [autoCopySelection, setAutoCopySelection] = useState(
      initialState.autoCopySelection === true,
    ),
    [rightClickPaste, setRightClickPaste] = useState(
      initialState.rightClickPaste === true,
    ),
    [confirmMultilinePaste, setConfirmMultilinePaste] = useState(
      initialState.confirmMultilinePaste !== false,
    ),
    [showQuickCommandManager, setShowQuickCommandManager] = useState(false),
    [quickCommandFocus, setQuickCommandFocus] = useState(0),
    [terminalSearchFocus, setTerminalSearchFocus] = useState(0),
    [splitPair, setSplitPair] = useState<[string, string] | null>(null),
    [splitDirection, setSplitDirection] = useState<"columns" | "rows">("columns"),
    [splitRatio, setSplitRatio] = useState(Math.min(80, Math.max(20, initialState.splitRatio ?? 50))),
    [middleClickPaste, setMiddleClickPaste] = useState(initialState.middleClickPaste === true),
    [logHighlights, setLogHighlights] = useState(initialState.logHighlights === true),
    [profileID, setProfileID] = useState(
      initialState.profiles.find((p) => p.id === initialState.activeProfile)
        ?.id ??
        initialState.profiles[0]?.id ??
        "",
    ),
    [dialog, setDialog] = useState<{
      kind: "session" | "settings";
      session?: Session;
      groupID?: string;
    } | null>(null),
    [toast, setToast] = useState<unknown>(""),
    [notice, setNotice] = useState<DisplayText>(""),
    [aiWidth, setAIWidth] = useState(370),
    [sessionWidth, setSessionWidth] = useState(235),
    [challenge, setChallenge] = useState<{
      host: HostChallenge;
      tab: Tab;
      secret: string;
    } | null>(null),
    [login, setLogin] = useState<{ tab: Tab; secret: string } | null>(null),
    [preview, setPreview] = useState<{
      tabID: string;
      text: string;
      truncated: boolean;
    } | null>(null),
    [attachments, setAttachments] = useState<Record<string, string>>({});
  const [fileViews, setFileViews] = useState<Record<string, boolean>>({});
  const remoteUploadDirs = useRef<Record<string, string>>({});
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const splitDragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => splitDragCleanup.current?.(), []);
  const tabsRef = useRef(tabs),
    streamIDs = useRef<Record<string, string>>({}),
    selections = useRef<Record<string, string>>({});
  tabsRef.current = tabs;
  const activeTransferIds = useRef(new Map<string, Set<string>>());
  const activeZmodemTabs = useRef(new Set<string>());
  useEffect(() => {
    const sftp = listen("sftp:transfer", (task: SFTPTask) => {
      const set = activeTransferIds.current.get(task.ref.tabId) ?? new Set<string>();
      if (task.status === "queued" || task.status === "running") set.add(task.id);
      else set.delete(task.id);
      if (set.size) activeTransferIds.current.set(task.ref.tabId, set);
      else activeTransferIds.current.delete(task.ref.tabId);
    });
    const zmodem = listen("ssh:transfer-state", (payload: { ref: Ref; active: boolean }) => {
      if (payload.active) activeZmodemTabs.current.add(payload.ref.tabId);
      else activeZmodemTabs.current.delete(payload.ref.tabId);
    });
    const zmodemFinished = listen("ssh:transfer-finished", (payload: { ref: Ref }) => {
      if (payload?.ref) activeZmodemTabs.current.delete(payload.ref.tabId);
    });
    return () => { sftp(); zmodem(); zmodemFinished(); };
  }, []);
  const reconnectTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const reconnectInFlight = useRef(new Set<string>());
  const autoReconnectRef = useRef(state.autoReconnect !== false);
  autoReconnectRef.current = state.autoReconnect !== false;
  const showDisconnectReasonRef = useRef(state.showDisconnectReason !== false);
  showDisconnectReasonRef.current = state.showDisconnectReason !== false;
  const stopRetryTimer = (tabID: string) => {
    const timer = reconnectTimers.current.get(tabID);
    if (timer !== undefined) clearTimeout(timer);
    reconnectTimers.current.delete(tabID);
  };
  useEffect(() => () => {
    for (const timer of reconnectTimers.current.values()) clearTimeout(timer);
    reconnectTimers.current.clear();
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const activeIDRef = useRef(activeID);
  activeIDRef.current = activeID;
  const memory = useConversations();
  const rawActive = tabs.find((t) => t.id === activeID);
  const activeConversationID = rawActive
    ? (memory.selectedByTab[rawActive.id] ?? rawActive.conversationID)
    : undefined;
  const activeCache = activeConversationID
    ? memory.cache[activeConversationID]
    : undefined;
  const active: Tab | undefined = rawActive
    ? {
        ...rawActive,
        conversationID: activeConversationID,
        messages: activeConversationID === ""
          ? []
          : activeCache
            ? toChatMessages(activeCache)
            : rawActive.messages,
        memoryRun: activeCache?.run,
        memoryLoading:
          memory.loadingByTab[rawActive.id] ||
          !!(activeConversationID && !activeCache?.loaded),
        memoryError: memory.errors[rawActive.id],
        memoryStatus: activeCache?.status,
        hasEarlier: activeCache?.hasMore,
      }
    : undefined;
  const activeTerminalBackground = resolveTerminalTheme(theme, terminalTheme, active?.session.terminalTheme).background;
  const showSFTP = Boolean(active?.ref && active.status === "connected" && fileViews[activeID]);
  const splitReady = Boolean(
    !showSFTP && splitPair?.includes(activeID) &&
    splitPair.every((id) => tabs.some((tab) => tab.id === id && tab.status === "connected")),
  );
  const splitPartnerID = splitReady ? (splitPair?.find((id) => id !== activeID) ?? "") : "";
  const splitChoices = tabs.filter((tab) => tab.id !== activeID && tab.status === "connected");
  const setSplitRatioAndSave = (next: number) => {
    const ratio = Math.round(Math.max(20, Math.min(80, next)));
    setSplitRatio(ratio);
    void api.SavePreference("splitRatio", String(ratio)).catch(notify);
  };
  const startSplitResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !splitReady) return;
    const element = splitContainerRef.current;
    if (!element) return;
    event.preventDefault();
    splitDragCleanup.current?.();
    const pointerId = event.pointerId;
    const ratioFromEvent = (e: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      const length = splitDirection === "columns" ? rect.width : rect.height;
      if (length <= 0) return null;
      const position = splitDirection === "columns" ? e.clientX - rect.left : e.clientY - rect.top;
      return Math.round(Math.max(20, Math.min(80, position * 100 / length)));
    };
    let latest = splitRatio;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const next = ratioFromEvent(e);
      if (next === null) return;
      latest = next;
      setSplitRatio(next);
    };
    const cleanup = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", cancel);
      splitDragCleanup.current = null;
    };
    const stop = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      cleanup();
      setSplitRatioAndSave(latest);
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      cleanup();
      setSplitRatio(splitRatio);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", cancel);
    splitDragCleanup.current = cleanup;
  };
  const update = (tabID: string, fn: (tab: Tab) => Tab) =>
    setTabs((old) => old.map((t) => (t.id === tabID ? fn(t) : t)));
  const notify = (error: unknown) => setToast(error);
  const dropDialogs = useRef(dialogs);
  dropDialogs.current = dialogs;
  useEffect(() => {
    const fileRuntime = window.runtime as (typeof window.runtime & { OnFileDrop?: unknown }) | undefined;
    if (!desktop || typeof fileRuntime?.OnFileDrop !== "function") return;
    OnFileDrop((x, y, paths) => {
      const target = document.elementFromPoint(x, y);
      if (!target || paths.length === 0) return;
      const pane = target.closest<HTMLElement>(".terminal-pane[data-tab-id]");
      const isRemotePanel = Boolean(target.closest(".workspace-file-panel .sftp-remote"));
      const overTerminal = Boolean(target.closest(".terminal-container"));
      if (!pane && !overTerminal && !isRemotePanel) return;
      const tab = tabsRef.current.find(item =>
        item.id === (pane?.dataset.tabId || activeIDRef.current));
      if (!tab?.ref || tab.status !== "connected") return;
      const ref = tab.ref;
      void (async () => {
        const home = await api.SFTPHome(ref);
        const directory = isRemotePanel
          ? (remoteUploadDirs.current[tab.id] || home.remote)
          : home.remote;
        const approved = await dropDialogs.current.confirm({
          title: tr("sftp:confirmDropTitle"),
          description: tr("sftp:confirmDropDescription", {
            count: paths.length, directory, server: tab.session.name,
          }),
          confirmLabel: tr("sftp:upload"),
        });
        if (!approved) return;
        const existing = new Set((await api.SFTPList(ref, "remote", directory)).map(item => item.name));
        for (const path of paths) {
          const live = tabsRef.current.find(item => item.id === tab.id);
          if (!live?.ref || live.ref.sessionId !== ref.sessionId || live.ref.generation !== ref.generation) return;
          const name = path.split(/[\\/]/).filter(Boolean).at(-1);
          if (!name || name === "." || name === "..") continue;
          let overwrite = false;
          if (existing.has(name)) {
            overwrite = await dropDialogs.current.confirm({
              title: tr("sftp:overwriteTitle"),
              description: tr("sftp:overwriteDescription", { name }),
              tone: "warning",
              confirmLabel: tr("sftp:overwrite"),
            });
            if (!overwrite) continue;
          }
          const destination = directory.replace(/\\/g, "/").replace(/\/$/, "") + "/" + name;
          await api.SFTPTransfer(ref, "upload", path, destination, overwrite, true);
          existing.add(name);
        }
      })().catch(setToast);
    }, true);
    return () => OnFileDropOff();
  }, []);

  const refresh = async () => {
    try {
      const data = await api.State();
      setState(data);
      setTheme(data.theme === "light" ? "light" : "dark");
      setTerminalTheme(normalizeTerminalTheme(data.terminalTheme));
      setQuickCommandLayout(
        data.quickCommandLayout === "multi" ? "multi" : "single",
      );
      setAutoCopySelection(data.autoCopySelection === true);
      setRightClickPaste(data.rightClickPaste === true);
      setConfirmMultilinePaste(data.confirmMultilinePaste !== false);
      setMiddleClickPaste(data.middleClickPaste === true);
      setLogHighlights(data.logHighlights === true);
      setSplitRatio(Math.min(80, Math.max(20, data.splitRatio ?? 50)));
      if (data.fontSize)
        setFontSize(Math.max(11, Math.min(24, Number(data.fontSize) || 14)));
      setProfileID((old) =>
        data.profiles.some((p) => p.id === old)
          ? old
          : data.profiles.some((p) => p.id === data.activeProfile)
            ? data.activeProfile
            : (data.profiles[0]?.id ?? ""),
      );
    } catch (e) {
      if (desktop) notify(e);
    }
  };
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const memoryFailure = listen(
      "conversation:error",
      (event: { error: unknown }) => notify(event.error),
    );
    const lost = listen("ssh:connection-lost", (payload: { ref: Ref; reason: string }) => {
      if (!showDisconnectReasonRef.current) return;
      const reasons: Record<string, string> = {
        keepalive_timeout: tr("common:connectionLostReasonKeepaliveTimeout"),
        keepalive_failed: tr("common:connectionLostReasonKeepaliveFailed"),
        network_timeout: tr("common:connectionLostReasonNetworkTimeout"),
        remote_closed: tr("common:connectionLostReasonRemoteClosed"),
        connection_lost: tr("common:connectionLostReasonConnectionLost"),
      };
      update(payload.ref.tabId, t => t.ref?.generation === payload.ref.generation
        ? { ...t, error: reasons[payload.reason] ?? tr("common:connectionLostReasonConnectionLost") } : t);
    });
    const off = listen("ssh:disconnected", (ref: Ref) =>
      update(ref.tabId, t => {
        if (t.ref?.generation !== ref.generation || t.manualDisconnected) return t;
        return {
          ...t, status: autoReconnectRef.current ? "reconnecting" : "disconnected",
          retryCount: 0, chatBusy: false, executing: false, proposal: null,
          error: t.error || message("common:connectionInterrupted"),
        };
      }),
    );
    const end = listen("ssh:terminal-ended", (ref: Ref) => {
      const tab = tabsRef.current.find(t => t.id === ref.tabId);
      if (!tab || tab.ref?.generation !== ref.generation || tab.manualDisconnected) return;
      update(ref.tabId, t => t.ref?.generation === ref.generation && !t.manualDisconnected
        ? { ...t, status: "disconnected", manualDisconnected: true,
            localFallbackPending: true,
            error: message("common:terminalProcessEndedReconnectToContinue") }
        : t);
      void api.Disconnect(ref)
        .then(() => update(ref.tabId, t => t.ref?.generation === ref.generation &&
          t.status === "disconnected" && t.manualDisconnected
          ? { ...t, localFallbackPending: false } : t))
        .catch(notify);
    });
    const autoEvent = listen("auto:event", (event: AutoEvent) => {
      const s = event.state;
      update(s.ref.tabId, (t) => {
        if (
          t.ref?.generation !== s.ref.generation ||
          t.ref.sessionId !== s.ref.sessionId ||
          t.autoRun?.id !== s.id
        )
          return t;
        if (event.kind === "thinking" && event.messageId)
          streamIDs.current[s.ref.tabId] = event.messageId;
        const terminal = ["completed", "stopped", "error"].includes(s.status);
        const next = { ...t, autoRun: s };
        if (event.kind === "thinking") {
          next.chatBusy = true;
          next.messages = [
            ...t.messages,
            { id: event.messageId!, role: "assistant", text: "" },
          ];
        } else if (event.kind === "reply") {
          next.chatBusy = false;
          next.proposal = s.proposal ?? null;
          next.messages = t.messages.map((m) =>
            m.id === event.messageId
              ? {
                  ...m,
                  text:
                    event.text ||
                    (s.proposal
                      ? tr("common:commandProposalReady")
                      : tr("common:noTextReturned")),
                }
              : m,
          );
        } else if (event.kind === "executing") {
          next.executing = true;
          next.proposal = s.proposal ?? null;
        } else if (event.kind === "result") {
          next.executing = false;
          next.proposal = null;
          next.messages = [
            ...t.messages,
            {
              id: id(),
              role: "result",
              text: "",
              result: event.result,
              command: s.proposal?.command,
            },
          ];
        }
        if (terminal) {
          next.chatBusy = false;
          next.executing = false;
          next.proposal = null;
          next.messages = next.messages.map((m) =>
            m.id === event.messageId && !m.text && m.role === "assistant"
              ? {
                  ...m,
                  text: reasonText(s) || tr("common:taskEnded"),
                  incomplete: s.status !== "completed",
                }
              : m,
          );
          delete streamIDs.current[s.ref.tabId];
        }
        if (t.conversationID) next.messages = t.messages;
        return next;
      });
    });
    const delta = listen("ai:delta", (payload: { ref: Ref; text: string }) => {
      const messageID = streamIDs.current[payload.ref.tabId];
      if (messageID)
        update(payload.ref.tabId, (t) =>
          t.ref?.generation === payload.ref.generation
            ? {
                ...t,
                messages: t.messages.map((m) =>
                  m.id === messageID
                    ? { ...m, text: m.text + payload.text }
                    : m,
                ),
              }
            : t,
        );
    });
    return () => {
      off();
      lost();
      memoryFailure();
      end();
      delta();
      autoEvent();
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 7000);
    return () => clearTimeout(timer);
  }, [toast]);
  const saveQuickCommands = async (commands: QuickCommand[]) => {
    await api.SavePreference("quickCommands", JSON.stringify(commands));
    setState((current) => ({ ...current, quickCommands: commands }));
  };
  const runQuickCommand = async (command: QuickCommand) => {
    const tab = active;
    if (!tab?.ref || tab.status !== "connected") {
      notify(message("common:connectToAnSshServerFirst"));
      return;
    }
    const risky =
      /(?:^|[;&|\s]+)(?:rm\s+-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)|mkfs(?:\.[\w]+)?|dd\s+|shutdown\b|reboot\b|poweroff\b|systemctl\s+(?:stop|restart|disable)\b)/i.test(
        command.command,
      );
    const willRun = /[\r\n]/.test(command.command);
    if (command.confirm || risky) {
      const accepted = await dialogs.confirm({
        title: risky
          ? message("common:confirmDangerousCommand")
          : message("common:confirmQuickCommand"),
        description: message("common:targetTheFollowingCommand", {
          name: tab.session.name,
          action: willRun
            ? tr("common:runAction")
            : tr("common:insertAction"),
        }),
        preview: command.command,
        tone: risky ? "warning" : "default",
        confirmLabel: willRun
          ? message("common:runCommand")
          : message("common:insertCommand"),
      });
      if (!accepted) return;
    }
    const current = tabsRef.current.find((item) => item.id === tab.id);
    if (
      !current ||
      current.status !== "connected" ||
      current.ref?.generation !== tab.ref.generation ||
      current.ref?.sessionId !== tab.ref.sessionId ||
      activeIDRef.current !== tab.id
    ) {
      notify(message("common:sshConnectionChangedOrClosedCommandWasNot"));
      return;
    }
    try {
      const source = quickCommandTerminalInput(command.command);
      const bytes = new TextEncoder().encode(source);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      await api.WriteTerminal(tab.ref, btoa(binary));
      setQuickCommandFocus((n) => n + 1);
    } catch (e) {
      notify(e);
    }
  };
  const connect = async (tab: Tab, secret = "") => {
    update(tab.id, (t) => ({
      ...t,
      status: "connecting",
      manualDisconnected: false,
      localFallbackPending: false,
      retryCount: 0,
      error: "",
      proposal: null,
      messages: [],
      chatBusy: false,
    }));
    try {
      const result = await api.Connect(tab.id, tab.session.id, secret);
      if (!tabsRef.current.some((t) => t.id === tab.id)) {
        await api.CloseTab(tab.id);
        return;
      }
      if (result.challenge) {
        setChallenge({ host: result.challenge, tab, secret });
        update(tab.id, (t) => ({
          ...t,
          ref: result.ref,
          status: "disconnected",
        }));
        return;
      }
      update(tab.id, (t) => ({
        ...t,
        ref: result.ref,
        conversationID: result.conversationId,
        status: "connected", everConnected: true,
        home: result.home,
        cwd: result.home,
        cwdReported: false,
        error: "",
      }));
      if (result.conversationId)
        await memory.restore(result.ref, result.conversationId);
    } catch (e) {
      update(tab.id, (t) => t.manualDisconnected ? t : ({ ...t, status: "error", error: e }));
      if (!tabsRef.current.find(t => t.id === tab.id)?.manualDisconnected) notify(e);
    }
  };
  const open = (session: Session, afterTabID?: string) => {
    const tab: Tab = {
      id: id(),
      session,
      ref: null,
      status: "disconnected",
      home: "",
      cwd: "",
      cwdReported: false,
      messages: [],
      proposal: null,
      chatBusy: false,
      executing: false,
      error: "",
    };
    setTabs((old) => {
      const index = afterTabID
        ? old.findIndex((item) => item.id === afterTabID)
        : -1;
      if (index < 0) return [...old, tab];
      return [...old.slice(0, index + 1), tab, ...old.slice(index + 1)];
    });
    setActiveID(tab.id);
    if (session.authType === "password" && !session.credentialRef)
      setLogin({ tab, secret: "" });
    else setTimeout(() => connect(tab), 0);
  };
  useEffect(() => {
    const enabled = state.autoReconnect !== false;
    for (const tab of tabs) {
      if (tab.status === "reconnecting" && !enabled) {
        stopRetryTimer(tab.id);
        update(tab.id, t => ({ ...t, status: "disconnected", error: message("common:reconnectStopped") }));
        continue;
      }
      if (tab.status !== "reconnecting" || tab.manualDisconnected) {
        stopRetryTimer(tab.id);
        continue;
      }
      if (reconnectTimers.current.has(tab.id) || reconnectInFlight.current.has(tab.id)) continue;
      const nextAttempt = (tab.retryCount ?? 0) + 1;
      const limit = state.maxReconnectAttempts ?? 10;
      if (limit > 0 && nextAttempt > limit) {
        update(tab.id, t => ({ ...t, status: "disconnected", error: message("common:reconnectStopped") }));
        continue;
      }
      const expectedGeneration = tab.ref?.generation;
      const intervals = [1000, 2000, 5000, 10000, 20000, 30000];
      const timer = setTimeout(async () => {
        reconnectTimers.current.delete(tab.id);
        const current = tabsRef.current.find(t => t.id === tab.id);
        if (!current || current.status !== "reconnecting" ||
            current.manualDisconnected || current.ref?.generation !== expectedGeneration) return;
        reconnectInFlight.current.add(tab.id);
        try {
          const result = await api.Reconnect(tab.id, tab.session.id);
          const latest = tabsRef.current.find(t => t.id === tab.id);
          if (!latest || latest.manualDisconnected || latest.status !== "reconnecting") {
            await api.Disconnect(result.ref).catch(() => {});
            return;
          }
          if (result.challenge) {
            update(tab.id, t => ({ ...t, status: "disconnected", error: message("common:reconnectStopped") }));
            setChallenge({ host: result.challenge, tab: latest, secret: "" });
            return;
          }
          update(tab.id, t => ({
            ...t, ref: result.ref, conversationID: result.conversationId,
            status: "connected", everConnected: true, home: result.home, cwd: result.home,
            retryCount: 0, error: "", manualDisconnected: false,
          }));
          if (result.conversationId) await memory.restore(result.ref, result.conversationId);
        } catch (error) {
          const code = decodeAppError(error)?.code;
          const authenticationErrors = new Set([
            "sshAuthentication", "couldNotReadLoginCredentialsEnterThemAgain",
            "fingerprintChanged", "fingerprintFirst",
            "privateKeyInvalid", "privateKeyRead",
          ]);
          const requiresAuthentication = (code !== undefined && authenticationErrors.has(code)) ||
            /authenticat|credential|password|passphrase|fingerprint|private.key/i.test(String(error));
          update(tab.id, t => t.status !== "reconnecting" || t.manualDisconnected ? t : ({
            ...t, status: requiresAuthentication ? "disconnected" : "reconnecting",
            retryCount: nextAttempt, error,
          }));
        } finally {
          reconnectInFlight.current.delete(tab.id);
        }
      }, intervals[Math.min(nextAttempt - 1, intervals.length - 1)]);
      reconnectTimers.current.set(tab.id, timer);
    }
    for (const [tabID] of reconnectTimers.current) {
      if (!tabs.some(t => t.id === tabID && t.status === "reconnecting" && !t.manualDisconnected)) stopRetryTimer(tabID);
    }
  }, [tabs, state.autoReconnect, state.maxReconnectAttempts]);
  const autoClosingTabs = useRef(new Set<string>());
  useEffect(() => {
    if ((state.disconnectBehavior ?? "local") !== "close") {
      autoClosingTabs.current.clear();
      return;
    }
    for (const tab of tabs) {
      if (!tab.everConnected || !["disconnected", "error"].includes(tab.status) ||
          autoClosingTabs.current.has(tab.id)) continue;
      autoClosingTabs.current.add(tab.id);
      void close(tab);
    }
  }, [tabs, state.disconnectBehavior]);
  const openFromPicker = (session: Session) => {
    setShowSessionPicker(false);
    const existing = tabsRef.current.find(
      (tab) => tab.session.id === session.id,
    );
    if (!existing) {
      open(session);
      return;
    }
    setActiveID(existing.id);
    if (existing.status === "disconnected" || existing.status === "error") {
      if (session.authType === "password" && !session.credentialRef)
        setLogin({ tab: existing, secret: "" });
      else void connect(existing);
    }
  };
  const manualConnect = (tab: Tab) => {
    stopRetryTimer(tab.id);
    if (tab.session.authType === "password" && !tab.session.credentialRef) {
      setLogin({ tab, secret: "" });
    } else {
      void connect(tab);
    }
  };
  const disconnectTab = async (tab: Tab) => {
    if (!tab.ref && tab.status !== "connecting") return;
    const hasTransfers = Boolean(activeTransferIds.current.get(tab.id)?.size) ||
      activeZmodemTabs.current.has(tab.id);
    if (state.confirmActiveDisconnect !== false && (tab.chatBusy || tab.executing || hasTransfers)) {
      if (!(await dialogs.confirm({
        title: message("common:disconnectRunningTitle"),
        description: message("common:disconnectRunningDescription"),
        tone: "warning",
        confirmLabel: message("common:disconnectAnyway"),
      }))) return;
    }
    stopRetryTimer(tab.id);
    update(tab.id, t => ({
      ...t, status: "disconnected", manualDisconnected: true,
      localFallbackPending: true,
      retryCount: 0, chatBusy: false, executing: false, proposal: null,
      error: "",
    }));
    try {
      if (tab.status === "reconnecting" || tab.status === "connecting" || !tab.ref) {
        await api.CancelConnecting(tab.id);
      } else {
        await api.Disconnect(tab.ref);
      }
      update(tab.id, t => t.manualDisconnected && t.status === "disconnected" &&
        t.ref?.generation === tab.ref?.generation
        ? { ...t, localFallbackPending: false } : t);
    } catch (error) { notify(error); }
  };
  const close = async (tab: Tab) => {
    stopRetryTimer(tab.id);
    if (tab.chatBusy || tab.executing || tab.proposal) {
      if (
        !(await dialogs.confirm({
          title: message("common:closeRunningTask"),
          description: message("common:thisTabHasAnAiTaskOrPending"),
          tone: "warning",
          confirmLabel: message("common:closeAnyway"),
        }))
      )
        return;
    }
    try {
      await api.CloseTab(tab.id);
      memory.forget(tab.id);
      setTabs((old) => old.filter((t) => t.id !== tab.id));
      if (activeID === tab.id) {
        const rest = tabsRef.current.filter((t) => t.id !== tab.id);
        setActiveID(rest.at(-1)?.id ?? "");
      }
      delete streamIDs.current[tab.id];
      delete selections.current[tab.id];
      setAttachments((old) => {
        const next = { ...old };
        delete next[tab.id];
        return next;
      });
    } catch (e) {
      notify(e);
    }
  };
  const removeSession = async (s: Session) => {
    if (tabs.some((t) => t.session.id === s.id)) {
      notify(message("common:closeThisSessionSTerminalTabsFirst"));
      return;
    }
    if (
      !(await dialogs.confirm({
        title: message("common:deleteSshSession"),
        description: message("common:deleteThisCannotBeUndone", {
          name: s.name,
        }),
        tone: "danger",
        confirmLabel: message("common:deleteSession"),
      }))
    )
      return;
    if (tabsRef.current.some((tab) => tab.session.id === s.id)) {
      notify(message("common:closeTheSessionSOpenTerminalTabsFirst"));
      return;
    }
    try {
      await api.DeleteSession(s.id);
      await refresh();
    } catch (e) {
      notify(e);
    }
  };
  const saveSession = async (req: SessionRequest) => {
    const previous = state.sessions.find(
      (session) => session.id === req.session.id,
    );
    try {
      const saved = await api.SaveSession(req);
      setTabs((current) =>
        current.map((tab) =>
          tab.session.id === saved.id ? { ...tab, session: saved } : tab,
        ),
      );
      const connectionChanged =
        previous &&
        (previous.host !== saved.host ||
          previous.port !== saved.port ||
          previous.username !== saved.username ||
          previous.authType !== saved.authType ||
          previous.privateKeyPath !== saved.privateKeyPath ||
          previous.useSSHConfig !== saved.useSSHConfig ||
          (previous.proxyJump ?? "") !== (saved.proxyJump ?? "") ||
          JSON.stringify(previous.localForwards ?? []) !== JSON.stringify(saved.localForwards ?? []) ||
          req.secret !== "" ||
          (previous.credentialRef !== "" && !req.saveSecret));
      const connected = tabsRef.current.some(
        (tab) =>
          tab.session.id === saved.id &&
          (tab.status === "connected" || tab.status === "connecting"),
      );
      setNotice(
        message(
          connected && connectionChanged
            ? "common:sessionConnectionChangesOnNextReconnect"
            : "common:sessionSaved",
        ),
      );
    } finally {
      await refresh();
    }
  };
  const duplicateSession = async (session: Session): Promise<Session | undefined> => {
    try {
      const duplicated = await api.DuplicateSession(session.id);
      await refresh();
      setNotice(message("common:sessionDuplicated"));
      return duplicated;
    } catch (error) {
      notify(error);
      return undefined;
    }
  };
  const openXshellImport = async () => {
    try {
      const preview = await api.PreviewXshellImport();
      if (preview.token) setXshellPreview(preview);
    } catch (error) { notify(error); }
  };
  const previewBackup = async () => {
    try {
      const preview = await api.PreviewSessionBackup();
      if (preview.token) setXshellPreview(preview);
    } catch (error) { notify(error); }
  };
  const exportBackup = async () => {
    try {
      const path = await api.ExportSessionBackup();
      if (path) setNotice(message("sessions:backupSaved"));
    } catch (error) { notify(error); }
  };
  const importXshell = async (ids: string[], conflict: "skip" | "rename") => {
    if (!xshellPreview) return;
    const result = await api.ImportXshell(xshellPreview.token, ids, conflict);
    await refresh();
    setXshellPreview(null);
    setNotice(message("sessions:xshellImportResult", { imported: result.imported, skipped: result.skipped }));
  };
  const group = async (g?: Group, parentID = "") => {
    const name = await dialogs.input({
      icon: g ? "rename" : "create",
      title: g ? message("common:renameFolder") : message("common:newFolder"),
      description: g
        ? message("common:changeThisFolderSName")
        : message("common:createAFolderToOrganizeSshSessions"),
      label: message("common:folderName"),
      defaultValue: g?.name ?? "",
      placeholder: message("common:eGProduction"),
      confirmLabel: g
        ? message("common:saveChanges")
        : message("common:createFolder"),
    });
    if (!name) return;
    try {
      await api.SaveGroup({ id: g?.id ?? "", name: name.trim(), parentId: g?.parentId ?? parentID });
      await refresh();
    } catch (e) {
      notify(e);
    }
  };
  const deleteGroup = async (g: Group) => {
    if (
      !(await dialogs.confirm({
        title: message("common:deleteFolder"),
        description: message("common:deleteItsSshSessionsWillMoveToThe", {
          name: g.name,
        }),
        tone: "danger",
        confirmLabel: message("common:deleteFolder"),
      }))
    )
      return;
    try {
      await api.DeleteGroup(g.id);
      await refresh();
    } catch (e) {
      notify(e);
    }
  };
  const requestFor = (
    tab: Tab,
    text: string,
    operate: boolean,
    context = "",
  ): ChatRequest => ({
    requestId: id(),
    ref: tab.ref!,
    profileId: profileID,
    text: tab.cwd
      ? tr("common:currentAiWorkingDirectory", { text, cwd: tab.cwd })
      : text,
    context,
    operate,
  });
  const chat = async (
    tab: Tab,
    text: string,
    operate: boolean,
    context = "",
    continuation = false,
  ) => {
    if (!tab.ref) return;
    const messageID = id();
    streamIDs.current[tab.id] = messageID;
    update(tab.id, (t) => ({
      ...t,
      chatBusy: true,
      autoRun: continuation ? t.autoRun : undefined,
      messages: t.conversationID
        ? t.messages
        : [
            ...t.messages,
            ...(continuation
              ? []
              : [{ id: id(), role: "user" as const, text }]),
            { id: messageID, role: "assistant", text: "" },
          ],
      error: "",
    }));
    setAttachments((old) => ({ ...old, [tab.id]: "" }));
    try {
      const response = await (continuation ? api.Continue : api.Chat)(
        requestFor(tab, text, operate, context),
      );
      update(tab.id, (t) =>
        t.ref?.generation === tab.ref?.generation
          ? {
              ...t,
              chatBusy: false,
              messages: t.messages.map((m) =>
                m.id === messageID
                  ? {
                      ...m,
                      text:
                        response.text ||
                        (response.proposal
                          ? tr("common:commandProposalReady")
                          : tr("common:noTextReturned")),
                    }
                  : m,
              ),
              proposal: response.proposal ?? null,
            }
          : t,
      );
    } catch (e) {
      update(tab.id, (t) => ({
        ...t,
        chatBusy: false,
        messages: t.messages.map((m) =>
          m.id === messageID
            ? { ...m, incomplete: true, text: m.text || errorText(e) }
            : m,
        ),
      }));
      notify(e);
    } finally {
      delete streamIDs.current[tab.id];
    }
  };
  const startAutomatic = async (tab: Tab, text: string, context: string) => {
    if (!tab.ref) return;
    const taskID = id();
    update(tab.id, (t) => ({
      ...t,
      proposal: null,
      autoRun: {
        id: taskID,
        ref: tab.ref!,
        status: "ready",
        steps: 0,
        roundSteps: 0,
        limit: state.autoCommandLimit ?? 10,
        allowChanges: state.autoAllowChanges ?? false,
        reason: "",
        reasonCode: "taskStarting",
      },
      messages: t.conversationID
        ? t.messages
        : [...t.messages, { id: id(), role: "user", text }],
    }));
    setAttachments((old) => ({ ...old, [tab.id]: "" }));
    try {
      await api.StartAutomatic(requestFor(tab, text, true, context), taskID);
    } catch (e) {
      await api.StopAutomatic(tab.ref!, taskID).catch(notify);
      update(tab.id, (t) =>
        t.autoRun?.id === taskID
          ? {
              ...t,
              chatBusy: false,
              executing: false,
              proposal: null,
              autoRun: {
                ...t.autoRun,
                status: "error",
                reason: e instanceof Error ? e.message : String(e),
                reasonCode: undefined,
              },
            }
          : t,
      );
      notify(e);
    }
  };
  const resumeAutomatic = async (extend: boolean) => {
    if (!active?.autoRun) return;
    try {
      await api.ResumeAutomatic(
        active.ref!,
        active.autoRun.id,
        extend ? "" : (active.proposal?.id ?? ""),
        extend,
      );
    } catch (e) {
      notify(e);
    }
  };
  const sendChat = (text: string, mode: ChatMode, context: string) => {
    if (!active) return;
    if (mode === "auto") return startAutomatic(active, text, context);
    return chat(active, text, mode !== "chat", context);
  };
  const confirmCommand = async () => {
    if (active?.autoRun?.status === "awaiting_confirmation")
      return resumeAutomatic(false);
    if (!active?.proposal) return;
    const tab = active,
      p = active.proposal;
    update(tab.id, (t) => ({ ...t, executing: true }));
    try {
      const result = await api.ConfirmCommand(tab.ref!, p.id);
      update(tab.id, (t) => ({
        ...t,
        executing: false,
        proposal: null,
        messages: t.conversationID
          ? t.messages
          : [...t.messages, { id: id(), role: "result", text: "", result }],
      }));
      if (
        result.status !== "unknown" &&
        tabsRef.current.some((t) => t.id === tab.id) &&
        tab.ref
      )
        await chat(tab, "", true, "", true);
    } catch (e) {
      update(tab.id, (t) => ({ ...t, executing: false, proposal: null }));
      notify(e);
    }
  };
  const cancelCommand = async () => {
    if (
      active?.autoRun &&
      ["ready", "running", "awaiting_confirmation", "limit"].includes(
        active.autoRun.status,
      )
    ) {
      await api.StopAutomatic(active.ref!, active.autoRun.id).catch(notify);
      return;
    }
    if (!active?.proposal) return;
    try {
      await api.CancelCommand(active.ref!, active.proposal.id);
      if (!active.executing)
        update(active.id, (t) => ({
          ...t,
          proposal: null,
          messages: t.conversationID
            ? t.messages
            : [
                ...t.messages,
                {
                  id: id(),
                  role: "result",
                  text: tr("common:commandRejectedNothingWasRun"),
                },
              ],
        }));
    } catch (e) {
      notify(e);
    }
  };
  const stop = () => {
    if (!active) return;
    if (
      active.autoRun &&
      ["ready", "running", "awaiting_confirmation", "limit"].includes(
        active.autoRun.status,
      )
    )
      api.StopAutomatic(active.ref!, active.autoRun.id).catch(notify);
    else if (active.executing) cancelCommand();
    else api.CancelChat(active.ref!).catch(notify);
  };
  const clear = async () => {
    if (!active) return;
    if (
      active.conversationID &&
      !(await dialogs.confirm({
        title: message("ai:clearChat"),
        description: message("ai:sharedClearDescription"),
        tone: "danger",
        confirmLabel: message("ai:clearChat"),
      }))
    )
      return;
    try {
      await api.ClearChat(active.id);
      update(active.id, (t) => ({ ...t, messages: [], proposal: null }));
    } catch (e) {
      notify(e);
    }
  };
  const previewContext = async () => {
    if (!active?.ref) return;
    try {
      const value = await api.PreviewContext(
        active.ref,
        selections.current[active.id] ?? "",
      );
      setPreview({ tabID: active.id, ...value });
    } catch (e) {
      notify(e);
    }
  };
  const drag = (kind: "ai" | "sessions", event: React.PointerEvent) => {
    const start = event.clientX,
      width = kind === "ai" ? aiWidth : sessionWidth;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      if (kind === "ai")
        setAIWidth(Math.max(310, Math.min(620, width + start - e.clientX)));
      else
        setSessionWidth(
          Math.max(190, Math.min(360, width + e.clientX - start)),
        );
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };
  return (
    <div
      className="app"
      style={
        {
          "--session-width": `${sessionWidth}px`,
          "--ai-width": `${aiWidth}px`,
        } as React.CSSProperties
      }
    >
      {showSessions && (
        <>
          <SessionTree
            sessions={state.sessions}
            groups={state.groups}
            active={active?.session.id ?? ""}
            onOpen={open}
            onEdit={(session) => setDialog({ kind: "session", session })}
            onDelete={removeSession}
            onDuplicate={duplicateSession}
            onCreateInGroup={(groupID) =>
              setDialog({ kind: "session", groupID })
            }
            onGroup={() => group()}
            onCreateSubgroup={(parent) => group(undefined, parent.id)}
            onImport={openXshellImport}
            onRenameGroup={group}
            onDeleteGroup={deleteGroup}
            onSettings={() => setDialog({ kind: "settings" })}
          />
          <div
            className="splitter"
            onPointerDown={(e) => drag("sessions", e)}
          />
        </>
      )}
      <main className="workspace">
        <header className="workspace-header">
          <button
            title={
              showSessions
                ? tr("common:collapseSessions")
                : tr("common:expandSessions")
            }
            onClick={() => setShowSessions(!showSessions)}
          >
            {showSessions ? (
              <PanelLeftClose size={17} />
            ) : (
              <PanelLeftOpen size={17} />
            )}
          </button>
          <span className="workspace-label">{tr("common:sshTerminal")}</span>
          <span className="header-divider" />
          <span className="muted">
            {active?.session.name ?? tr("common:workspace")}
          </span>
          <div className="header-right">
            <span className="local-badge">{tr("common:localLabel")}</span>
            {!showAI && (
              <button
                title={tr("common:expandAi")}
                onClick={() => setShowAI(true)}
              >
                <PanelRightOpen size={18} />
              </button>
            )}
          </div>
        </header>
        <div className="tab-strip">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`terminal-tab ${activeID === tab.id ? "active" : ""}`}
            >
              <button
                title={tr("common:doubleClickToDuplicateSession")}
                onClick={() => setActiveID(tab.id)}
                onDoubleClick={() => open(tab.session, tab.id)}
              >
                <span
                  className={`status-dot ${tab.status === "connected" ? "" : tab.status === "connecting" ? "connecting" : "offline"}`}
                />
                <span>{tab.session.name}</span>
                {tab.status === "connecting" && (
                  <LoaderCircle size={12} className="spin" />
                )}
              </button>
              <button
                title={tr("common:closeTab", { name: tab.session.name })}
                onClick={() => close(tab)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button
            className="new-tab"
            title={tr("common:openSessionList")}
            onClick={() => setShowSessionPicker(true)}
          >
            <Plus size={16} />
          </button>
        </div>
        {!tabs.length ? (
          <div className="workspace-empty">
            <div className="terminal-emblem">
              <Terminal size={41} strokeWidth={1.3} />
              <span />
            </div>
            <span className="eyebrow">{tr("common:lighterConnection")}</span>
            <h1>{tr("common:connectYourServerGetToWork")}</h1>
            <p>
              {tr("common:aFocusedTerminalAiAtYourSide")}
              <br />
              {tr("common:yourSessionsModelsAndActionsUnderYourControl")}
            </p>
            <button
              className="primary"
              onClick={() => setDialog({ kind: "session" })}
            >
              <Plus size={16} />
              {tr("common:newSshSession")}
              <ArrowRight size={15} />
            </button>
            <div className="welcome-features">
              <span>
                <Server size={15} />
                {tr("common:sessions")}
              </span>
              <span>
                <Terminal size={15} />
                {tr("common:sshTerminal")}
              </span>
              <span>
                <Sparkles size={15} />
                {tr("common:customAi")}
              </span>
            </div>
            <div className="empty-shortcut">
              {tr("common:doubleClickASessionOnTheLeftTo")}
            </div>
            {!desktop && (
              <div className="preview-notice">
                {tr("common:interfacePreviewUseTheWindowsAppForSsh")}
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="terminal-toolbar">
              <span>
                <Server size={13} />
                {active?.session.username}@{active?.session.host}:
                {active?.session.port}
              </span>
              <div>
                <select
                  className="terminal-split-select"
                  aria-label={tr("terminal:splitWith")}
                  title={splitChoices.length ? tr("terminal:splitWith") : tr("terminal:splitNeedsTwo")}
                  disabled={active?.status !== "connected" || showSFTP || !splitChoices.length}
                  value={splitPartnerID}
                  onChange={(event) => {
                    const other = event.target.value;
                    setSplitPair(other ? [activeID, other] : null);
                  }}
                >
                  <option value="">{tr("terminal:splitWith")}</option>
                  {splitChoices.map((tab) => (
                    <option key={tab.id} value={tab.id}>{tab.session.name}</option>
                  ))}
                </select>
                {splitReady && (
                  <>
                    <button title={tr("terminal:rotateSplit")} aria-label={tr("terminal:rotateSplit")}
                      onClick={() => setSplitDirection((value) => value === "columns" ? "rows" : "columns")}>
                      {splitDirection === "columns" ? <Rows2 size={14} /> : <Columns2 size={14} />}
                    </button>
                    <button title={tr("terminal:closeSplit")} aria-label={tr("terminal:closeSplit")}
                      onClick={() => setSplitPair(null)}><X size={14} /></button>
                  </>
                )}
                <button
                  title={tr("terminal:findInTerminal")}
                  disabled={active?.status !== "connected"}
                  onClick={() => setTerminalSearchFocus((value) => value + 1)}
                >
                  <Search size={14} />
                </button>
                <button
                  title={tr(showSFTP ? "sftp:closeFilePanel" : "sftp:openFileManager")}
                  disabled={active?.status !== "connected"}
                  onClick={() => active && setFileViews(old => ({...old, [active.id]: !old[active.id]}))}
                >
                  {showSFTP ? <PanelRightOpen size={14} /> : <FolderOpen size={14} />}
                </button>
                <button
                  title={tr("common:reauthenticate")}
                  disabled={active?.status === "connecting"}
                  onClick={() =>
                    active && setLogin({ tab: active, secret: "" })
                  }
                >
                  <ShieldCheck size={14} />
                </button>
                <button
                  title={tr("common:reconnect")}
                  disabled={active?.status === "connecting" || active?.status === "reconnecting"}
                  onClick={() => active && manualConnect(active)}
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  title={tr(active?.status === "connecting" ? "common:cancelConnecting"
                    : active?.status === "reconnecting" ? "common:stopReconnecting" : "common:disconnect")}
                  disabled={!active || ["disconnected", "error"].includes(active.status)}
                  onClick={() => active && void disconnectTab(active)}
                >
                  <Unplug size={14} />
                </button>
                <button
                  title={tr("common:sendSelectedTextOrRecentOutputToAi")}
                  disabled={active?.status !== "connected"}
                  onClick={() => {
                    setShowAI(true);
                    previewContext();
                  }}
                >
                  <Sparkles size={14} />
                </button>
              </div>
            </div>
            <div className={`workspace-workarea ${showSFTP ? "with-sftp" : ""}`}>
            <div ref={splitContainerRef}
              className={`terminal-container ${splitReady ? `terminal-split terminal-split-${splitDirection}` : ""}`}
              style={{
                "--split-ratio": `${splitRatio}%`,
                "--terminal-background": activeTerminalBackground,
              } as CSSProperties}>
              {tabs.map((tab) => (
                <TerminalPane
                  key={tab.id}
                  tab={tab}
                  disconnectBehavior={state.disconnectBehavior ?? "local"}
                  localShell={state.localShell ?? "powershell"}
                  preserveHistory={state.preserveTerminalHistory !== false}
                  showDisconnectReason={state.showDisconnectReason !== false}
                  active={tab.id === activeID}
                  visible={tab.id === activeID || Boolean(splitReady && splitPair?.includes(tab.id))}
                  onActivate={() => setActiveID(tab.id)}
                  onDirectoryChange={(ref, directory) => {
                    update(ref.tabId, current =>
                      current.ref?.sessionId === ref.sessionId &&
                      current.ref?.generation === ref.generation &&
                      (current.cwd !== directory || !current.cwdReported)
                        ? { ...current, cwd: directory, cwdReported: true } : current,
                    );
                  }}
                  fontSize={fontSize}
                  theme={theme}
                  terminalTheme={terminalTheme}
                  autoCopySelection={autoCopySelection}
                  rightClickPaste={rightClickPaste}
                  middleClickPaste={middleClickPaste}
                  logHighlights={logHighlights}
                  confirmMultilinePaste={confirmMultilinePaste}
                  onNotice={notify}
                  commandFocusVersion={quickCommandFocus}
                  searchFocusVersion={terminalSearchFocus}
                  onError={(text) => {
                    update(tab.id, (t) => ({
                      ...t,
                      status: "error",
                      error: text,
                    }));
                    if (tab.ref) api.Disconnect(tab.ref).catch(() => {});
                    notify(text);
                  }}
                  onSelection={(text) => {
                    selections.current[tab.id] = text;
                  }}
                />
              ))}
              {splitReady && (
                <div className="terminal-split-handle"
                  role="separator"
                  tabIndex={0}
                  aria-label={tr("terminal:resizeSplit")}
                  aria-orientation={splitDirection === "columns" ? "vertical" : "horizontal"}
                  aria-valuemin={20} aria-valuemax={80} aria-valuenow={splitRatio}
                  title={tr("terminal:resetSplitRatio")}
                  onPointerDown={startSplitResize}
                  onDoubleClick={() => setSplitRatioAndSave(50)}
                  onKeyDown={(event) => {
                    const increment = event.shiftKey ? 10 : 5;
                    if (event.key === "Home" || event.key === "End") {
                      event.preventDefault();
                      setSplitRatioAndSave(event.key === "Home" ? 20 : 80);
                    } else if (
                      (splitDirection === "columns" && ["ArrowLeft", "ArrowRight"].includes(event.key)) ||
                      (splitDirection === "rows" && ["ArrowUp", "ArrowDown"].includes(event.key))
                    ) {
                      event.preventDefault();
                      setSplitRatioAndSave(splitRatio + (["ArrowRight", "ArrowDown"].includes(event.key) ? increment : -increment));
                    }
                  }}
                />
              )}
              {(active?.status === "connecting" || active?.status === "reconnecting") && (
                <div className="terminal-overlay">
                  <LoaderCircle size={23} className="spin" />
                  <p>
                    {active?.status === "reconnecting" ? tr("common:reconnecting") : tr("common:connecting")}
                    {active.session.host}…
                  </p>
                </div>
              )}
            </div>
            {tabs.filter(tab => tab.ref && tab.status === "connected").map(tab => {
              const visible = showSFTP && tab.id === activeID;
              return (
                <aside key={tab.id} className="workspace-file-panel"
                  aria-label={tr("sftp:fileManager")} aria-hidden={!visible}
                  style={visible ? undefined : { display: "none" }}>
                  {visible && (
                    <SFTPView refID={tab.ref!} profileID={profileID} onNotice={notify}
                      initialRemoteDirectory={active?.cwd}
                      cwdReported={active?.cwdReported === true}
                      onRemoteDirectoryChange={directory => {
                        remoteUploadDirs.current[tab.id] = directory;
                      }} hideTaskQueue />
                  )}
                  <TransferDock refID={tab.ref ?? undefined} onNotice={notify} alwaysVisible />
                </aside>
              );
            })}
            </div>
            {(
              <QuickCommandBar
                tab={active}
                commands={state.quickCommands ?? []}
                layout={quickCommandLayout}
                onManage={() => setShowQuickCommandManager(true)}
                onRun={runQuickCommand}
              />
            )}
          </>
        )}
        <footer className="workspace-status">
          <span className="workspace-version">
            OpenShell <span className="status-sep" />v{APP_VERSION}
          </span>
          <span className="workspace-connection">
            <i
              className={`status-dot ${active?.status === "connected" ? "" : "offline"}`}
            />
            {active?.status === "connected"
              ? tr("common:sshConnected")
              : active?.status === "connecting"
                ? tr("common:connecting2")
                : active?.status === "reconnecting"
                  ? tr("common:reconnecting")
                : active?.ref && active.everConnected && (state.disconnectBehavior ?? "local") === "local"
                  ? tr("terminal:localShellStatus", { name: state.localShell === "pwsh" ? "PowerShell 7" : state.localShell === "cmd" ? "CMD" : state.localShell === "wsl" ? "WSL" : "PowerShell" })
                  : tr("common:disconnected")}
            {active?.status === "connected" && (
              <>
                <span className="status-sep" />
                UTF-8
                <span className="status-sep" />
                xterm-256color
              </>
            )}
          </span>
        </footer>
      </main>
      {showAI && (
        <>
          <div className="splitter" onPointerDown={(e) => drag("ai", e)} />
          <AISidebar
            tab={active}
            profiles={state.profiles}
            conversationItems={
              memory.lists[
                activeCache?.conversation?.serverKey ??
                  (active ? memory.serverKeysByTab[active.id] : "")
              ]?.items ?? []
            }
            conversationHasMore={
              !!memory.lists[
                activeCache?.conversation?.serverKey ??
                  (active ? memory.serverKeysByTab[active.id] : "")
              ]?.nextCursor
            }
            onConversationSelect={(id) =>
              active?.ref && memory.select(active.ref, id).catch(notify)
            }
            onConversationCreate={async () => {
              if (!active?.ref || !active.conversationID) return;
              const ref = active.ref;
              try {
                await memory.draft(ref);
                update(active.id, (t) =>
                  t.ref?.generation === ref.generation
                    ? { ...t, conversationID: "", messages: [], proposal: null }
                    : t,
                );
              } catch (e) {
                notify(e);
              }
            }}
            onConversationRename={async (id) => {
              if (!active?.ref) return;
              const ref = active.ref;
              const title = await dialogs.input({
                title: message("ai:renameConversation"),
                description: message("ai:renameConversationDescription"),
                label: message("ai:conversationTitle"),
                defaultValue:
                  memory.lists[
                    activeCache?.conversation?.serverKey ??
                      (active ? memory.serverKeysByTab[active.id] : "")
                  ]?.items.find((item) => item.id === id)?.title ?? "",
                confirmLabel: message("common:saveChanges"),
              });
              if (title !== null)
                await memory.rename(ref, id, title).catch(notify);
            }}
            onConversationDelete={async (id) => {
              if (!active?.ref) return;
              const ref = active.ref;
              if (
                await dialogs.confirm({
                  title: message("ai:deleteConversation"),
                  description: message("ai:deleteConversationDescription"),
                  tone: "danger",
                  confirmLabel: message("ai:deleteConversation"),
                })
              )
                await memory.remove(ref, id).catch(notify);
            }}
            onConversationMore={() =>
              active?.ref &&
              (activeCache?.conversation?.serverKey ||
                memory.serverKeysByTab[active.id]) &&
              memory
                .list(
                  active.ref,
                  activeCache?.conversation?.serverKey ??
                    memory.serverKeysByTab[active.id],
                  true,
                )
                .catch(notify)
            }
            onLoadEarlier={() =>
              active?.ref &&
              active.conversationID &&
              memory
                .loadEarlier(active.ref, active.conversationID)
                .catch(notify)
            }
            onRetryHistory={() =>
              active?.ref &&
              active.conversationID &&
              memory.restore(active.ref, active.conversationID).catch(notify)
            }
            onFocusOwner={setActiveID}
            profileID={profileID}
            onProfile={(value) => {
              setProfileID(value);
              api.SavePreference("activeProfile", value).catch(notify);
            }}
            onHide={() => setShowAI(false)}
            onSettings={() => setDialog({ kind: "settings" })}
            onSend={sendChat}
            onAutoContinue={() => resumeAutomatic(true)}
            onStop={stop}
            onClear={clear}
            onPreview={previewContext}
            context={active ? (attachments[active.id] ?? "") : ""}
            onClearContext={() =>
              active && setAttachments({ ...attachments, [active.id]: "" })
            }
            onConfirm={confirmCommand}
            onCancel={cancelCommand}
            onRevise={async (command, cwd, seconds) => {
              if (!active?.proposal) return;
              try {
                const p = await api.ReviseProposal(
                  active.ref!,
                  active.proposal.id,
                  command,
                  cwd,
                  seconds,
                );
                update(active.id, (t) => ({ ...t, proposal: p }));
              } catch (e) {
                notify(e);
              }
            }}
          />
        </>
      )}
      {showSessionPicker && (
        <SessionPicker
          sessions={state.sessions}
          groups={state.groups}
          openedSessionIds={tabs.map((tab) => tab.session.id)}
          onConnect={openFromPicker}
          onOpenNewTab={(session) => {
            setShowSessionPicker(false);
            open(session);
          }}
          onEdit={(session) => {
            setShowSessionPicker(false);
            setDialog({ kind: "session", session });
          }}
          onDelete={(session) => void removeSession(session)}
          onNew={() => {
            setShowSessionPicker(false);
            setDialog({ kind: "session" });
          }}
          onNewGroup={() => void group()}
          onClose={() => setShowSessionPicker(false)}
        />
      )}
      {xshellPreview && (
        <XshellImportDialog
          preview={xshellPreview}
          onClose={() => setXshellPreview(null)}
          onImport={importXshell}
        />
      )}
      {dialog && (
        <SettingsDialog
          key={`${dialog.kind}-${dialog.session?.id ?? dialog.groupID ?? ""}`}
          {...dialog}
          sessionConnected={
            !!dialog.session &&
            tabs.some(
              (tab) =>
                tab.session.id === dialog.session?.id &&
                (tab.status === "connected" || tab.status === "connecting"),
            )
          }
          groups={state.groups}
          profiles={state.profiles}
          autoCommandLimit={state.autoCommandLimit}
          saveChatHistory={state.saveChatHistory}
          autoSummarize={state.autoSummarize}
          autoAllowChanges={state.autoAllowChanges}
          language={language}
          languageSaving={languageSaving}
          onLanguage={changeLanguage}
          fontSize={fontSize}
          theme={theme}
          onTheme={setTheme}
          terminalTheme={terminalTheme}
          onTerminalTheme={setTerminalTheme}
          quickCommandLayout={quickCommandLayout}
          onQuickCommandLayout={setQuickCommandLayout}
          autoCopySelection={autoCopySelection}
          onAutoCopySelection={setAutoCopySelection}
          rightClickPaste={rightClickPaste}
          onRightClickPaste={setRightClickPaste}
          middleClickPaste={middleClickPaste}
          onMiddleClickPaste={setMiddleClickPaste}
          logHighlights={logHighlights}
          onLogHighlights={setLogHighlights}
          confirmMultilinePaste={confirmMultilinePaste}
          onConfirmMultilinePaste={setConfirmMultilinePaste}
          onClose={() => setDialog(null)}
          onSession={saveSession}
          onExportSessionBackup={exportBackup}
          onImportSessionBackup={previewBackup}
          onRefresh={refresh}
          onFont={setFontSize}
          keepAliveSeconds={state.keepAliveSeconds}
          autoReconnect={state.autoReconnect}
          maxReconnectAttempts={state.maxReconnectAttempts}
          showDisconnectReason={state.showDisconnectReason}
          confirmActiveDisconnect={state.confirmActiveDisconnect}
          disconnectBehavior={state.disconnectBehavior}
          localShell={state.localShell}
          preserveTerminalHistory={state.preserveTerminalHistory}
        />
      )}
      {showQuickCommandManager && (
        <QuickCommandManager
          commands={state.quickCommands ?? []}
          groups={state.groups}
          sessions={state.sessions}
          onSave={saveQuickCommands}
          onClose={() => setShowQuickCommandManager(false)}
        />
      )}
      {login && (
        <div className="modal-backdrop">
          <section className="compact-dialog" role="dialog" aria-modal="true">
            <ShieldCheck className="dialog-icon" size={24} />
            <h2>
              {tr("common:connect")}
              {login.tab.session.name}
            </h2>
            <p className="muted">
              {login.tab.session.username}@{login.tab.session.host}:
              {login.tab.session.port}
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const value = login;
                setLogin(null);
                connect(value.tab, value.secret);
              }}
            >
              <label>
                {login.tab.session.authType === "key"
                  ? tr("common:keyPassphraseLeaveEmptyForUnencryptedKeys")
                  : tr("common:password")}
                <input
                  autoFocus
                  type="password"
                  value={login.secret}
                  onChange={(e) =>
                    setLogin({ ...login, secret: e.target.value })
                  }
                />
              </label>
              <p className="small muted">
                {tr("common:usedForThisConnectionOnlyNotSavedTo")}
              </p>
              <footer>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setLogin(null)}
                >
                  {tr("common:cancel")}
                </button>
                <button className="primary" type="submit">
                  {tr("common:connect")}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
      {challenge && (
        <div className="modal-backdrop">
          <section className="compact-dialog" role="dialog" aria-modal="true">
            <ShieldCheck className="dialog-icon" size={25} />
            <h2>
              {challenge.host.changed
                ? tr("common:serverFingerprintChanged")
                : tr("common:verifyServerFingerprint")}
            </h2>
            <p className="muted">{challenge.host.address}</p>
            <code className="fingerprint">{challenge.host.fingerprint}</code>
            <p>
              {challenge.host.changed
                ? tr("common:connectionBlockedVerifyWhyTheServerKeyChanged")
                : tr(
                    "common:verifyTheFingerprintWithYourServerAdministratorOr",
                  )}
            </p>
            <footer>
              <button className="secondary" onClick={() => setChallenge(null)}>
                {tr("common:cancel")}
              </button>
              {!challenge.host.changed && (
                <button
                  className="primary"
                  onClick={async () => {
                    const value = challenge;
                    setChallenge(null);
                    try {
                      await api.TrustHost(value.host.id);
                      await connect(value.tab, value.secret);
                    } catch (e) {
                      notify(e);
                    }
                  }}
                >
                  {tr("common:trustAndConnect")}
                </button>
              )}
            </footer>
          </section>
        </div>
      )}
      {preview && (
        <div className="modal-backdrop">
          <section className="context-dialog" role="dialog" aria-modal="true">
            <header>
              <div>
                <span className="eyebrow">{tr("common:contextPreview")}</span>
                <h2>{tr("common:sendTerminalTextToAi")}</h2>
              </div>
              <button
                title={tr("common:closePreview")}
                onClick={() => setPreview(null)}
              >
                <X size={18} />
              </button>
            </header>
            <p className="muted small">
              {tr("common:onlyTheTextBelowWillBeSentCommon")}
              {preview.truncated ? tr("common:contentTruncated") : ""}
            </p>
            <textarea
              aria-label={tr("common:terminalTextPreview")}
              value={preview.text}
              onChange={(e) => setPreview({ ...preview, text: e.target.value })}
            />
            <footer>
              <button className="secondary" onClick={() => setPreview(null)}>
                {tr("common:cancel")}
              </button>
              <button
                className="primary"
                onClick={() => {
                  setAttachments((old) => ({
                    ...old,
                    [preview.tabID]: preview.text,
                  }));
                  setShowAI(true);
                  setPreview(null);
                }}
              >
                {tr("common:attachToChat")}
              </button>
            </footer>
          </section>
        </div>
      )}
      <ZmodemProgressDialog activeRef={active?.ref ?? undefined} onNotice={notify} />
      {!!notice && !toast && (
        <div className="toast toast--success" role="status">
          <Check size={16} />
          <span>{renderMessage(notice)}</span>
          <button
            title={tr("common:dismissNotification")}
            onClick={() => setNotice("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {!!toast && (
        <div className="toast" role="alert">
          <AlertCircle size={16} />
          <span>{errorText(toast)}</span>
          <button
            title={tr("common:dismissNotification")}
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
