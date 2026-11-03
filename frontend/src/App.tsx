import packageManifest from "../package.json";
import { message, renderMessage, type DisplayText } from "./i18n/message";
import { t as tr } from "./i18n";
import { useTranslation } from "react-i18next";
import { initializeI18n, i18n } from "./i18n";
import { normalizeLanguage, type Language } from "./i18n/languages";
import { useState, useEffect, useRef, type CSSProperties } from "react";
import {
  Terminal,
  Plus,
  X,
  PanelRightOpen,
  RefreshCw,
  Unplug,
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
import { normalizeTerminalTheme, resolveTerminalTheme } from "./terminalThemes";
import { reorderTabs } from "./features/sessions/tabOrder";
import { hasInterruptibleWork, isActiveRemoteSession, sessionLabel } from "./features/sessions/closeProtection";
import WorkspaceTabStrip from "./components/WorkspaceTabStrip";
import type {
  Session,
  Group,
  AppState,
  Tab,
  Ref,
  HostChallenge,
  SessionRequest,
  Theme,
  QuickCommand,
  XshellImportPreview,
} from "./types";
import SessionTree from "./components/SessionTree";
import SessionPicker from "./components/SessionPicker";
import XshellImportDialog from "./components/XshellImportDialog";
import SettingsDialog from "./components/SettingsDialog";
import TerminalPane from "./components/TerminalPane";
import SFTPView from "./components/SFTPView";
import AISidebar from "./components/AISidebar";
import WindowTitleBar from "./components/WindowTitleBar";
import ZmodemFilePicker from "./components/ZmodemFilePicker";
import { useWorkspaceTabs } from "./features/sessions/useWorkspaceTabs";
import { useTabActivity } from "./features/sessions/useTabActivity";
import { useAutoReconnect } from "./features/sessions/useAutoReconnect";
import { useSplitWorkspace } from "./features/terminal/useSplitWorkspace";
import { useTabSplitDrop } from "./features/terminal/useTabSplitDrop";
import { useTransferActivity } from "./features/transfers/useTransferActivity";
import QuickCommandBar from "./components/QuickCommandBar";
import QuickCommandManager from "./components/QuickCommandManager";
import { quickCommandTerminalInput } from "./quickCommands";
import { normalizeRemoteDirectory } from "./terminalCwd";
import { DialogProvider, useDialogs } from "./components/DialogProvider";
import ModalSurface from "./components/ModalSurface";
const APP_VERSION = import.meta.env.VITE_APP_VERSION || packageManifest.version;
const initial: AppState = {
  sessions: [],
  groups: [],
  fontSize: "14",
  version: APP_VERSION,
};
const id = () => crypto.randomUUID();
const connectionActionLabel = (status?: Tab["status"]) => {
  switch (status) {
    case "connected": return "common:disconnect";
    case "connecting": return "common:cancelConnecting";
    case "reconnecting": return "common:stopReconnecting";
    case "error": return "common:retryConnection";
    default: return "common:reconnect";
  }
};
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
  const { tabs, setTabs, tabsRef, activeID, setActiveID, activeIDRef, update } = useWorkspaceTabs();
  const { hasActiveTransfers } = useTransferActivity();
  const [transferFocusRequest, setTransferFocusRequest] = useState<{ ref: Ref } | null>(null);
  useEffect(() => {
    const offFinished = listen("ssh:transfer-finished", (event: { ref: Ref }) => {
      if (event?.ref) setTransferFocusRequest({ ref: event.ref });
    });
    const offState = listen("ssh:transfer-state", (event: { ref: Ref; active: boolean }) => {
      if (event?.ref && event.active === false) setTransferFocusRequest({ ref: event.ref });
    });
    return () => { offFinished(); offState(); };
  }, []);
  const [state, setState] = useState(initialState),
    [sidebarMode, setSidebarMode] = useState<"pinned" | "auto-hide">(
      initialState.sessionSidebarMode === "auto-hide" ? "auto-hide" : "pinned",
    ),
    [autoSidebarOpen, setAutoSidebarOpen] = useState(false),
    [detailsExpanded, setDetailsExpanded] = useState(initialState.sessionDetailsExpanded === true),
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
    [logHighlights, setLogHighlights] = useState(initialState.logHighlights === true),
    [dialog, setDialog] = useState<{
      kind: "session" | "settings";
      session?: Session;
      groupID?: string;
    } | null>(null),
    [toast, setToast] = useState<unknown>(""),
    [notice, setNotice] = useState<DisplayText>(""),
    [sessionWidth, setSessionWidth] = useState(
      Math.max(190, Math.min(360, initialState.sessionSidebarWidth ?? 235)),
    ),
    [challenge, setChallenge] = useState<{
      host: HostChallenge;
      tab: Tab;
      secret: string;
    } | null>(null),
    [login, setLogin] = useState<{ tab: Tab; secret: string } | null>(null);
  const [fileViews, setFileViews] = useState<Record<string, boolean>>({});
  const [aiTerminalControls, setAITerminalControls] = useState<Record<string, {taskId: string; generation: number}>>({});
  const [alternateTerminals, setAlternateTerminals] = useState<Record<string, {generation: number; active: boolean}>>({});
  useEffect(() => {
    const off = listen("ai:terminal-control", (event: {
      taskId: string; ref: Ref; active: boolean;
    }) => {
      if (event.active) {
        setAITerminalControls(previous => ({
          ...previous,
          [event.ref.tabId]: { taskId: event.taskId, generation: event.ref.generation },
        }));
      } else {
        setAITerminalControls(previous => {
          const current = previous[event.ref.tabId];
          if (!current || current.taskId !== event.taskId) return previous;
          const next = { ...previous };
          delete next[event.ref.tabId];
          return next;
        });
      }
    });
    return off;
  }, []);
  const [aiSidebarMode, setAISidebarMode] = useState<"pinned" | "auto-hide">(
    initialState.aiSidebarMode === "pinned" ? "pinned" : "auto-hide",
  );
  const [aiSidebarWidth, setAISidebarWidth] = useState(
    Math.max(320, Math.min(480, initialState.aiSidebarWidth ?? 360)),
  );
  const [aiHoverOpen, setAIHoverOpen] = useState(false);
  const [aiFocusOpen, setAIFocusOpen] = useState(false);
  const aiHoverTimer = useRef<number | null>(null);
  const aiCloseTimer = useRef<number | null>(null);
  const toggleAIPin = () => {
    const next = aiSidebarMode === "pinned" ? "auto-hide" : "pinned";
    setAISidebarMode(next);
    void api.SavePreference("aiSidebarMode", next).catch(notify);
  };
  const closeAI = () => {
    if (aiSidebarMode === "pinned") {
      setAISidebarMode("auto-hide");
      void api.SavePreference("aiSidebarMode", "auto-hide").catch(notify);
    }
    if (aiHoverTimer.current !== null) window.clearTimeout(aiHoverTimer.current);
    if (aiCloseTimer.current !== null) window.clearTimeout(aiCloseTimer.current);
    setAIHoverOpen(false);
    setAIFocusOpen(false);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };
  useEffect(() => () => {
    if (aiHoverTimer.current !== null) window.clearTimeout(aiHoverTimer.current);
    if (aiCloseTimer.current !== null) window.clearTimeout(aiCloseTimer.current);
  }, []);
  const startAIResize = (event: React.PointerEvent) => {
    if (aiSidebarMode !== "pinned") return;
    const start = event.clientX;
    const initial = aiSidebarWidth;
    let changed = initial;
    const move = (e: PointerEvent) => {
      changed = Math.max(320, Math.min(480, initial + start - e.clientX));
      setAISidebarWidth(changed);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (changed !== initial) void api.SavePreference("aiSidebarWidth", String(changed)).catch(notify);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  const sidebarDockRef = useRef<HTMLDivElement>(null);
  const sidebarHovered = useRef(false);
  const sidebarKeyboardFocused = useRef(false);
  const sidebarPointerFocused = useRef(false);
  const sidebarOpenTimer = useRef<number | null>(null);
  const sidebarCloseTimer = useRef<number | null>(null);
  const remoteUploadDirs = useRef<Record<string, string>>({});
  const disconnectInFlight = useRef(new Set<string>());
  const [disconnectingTabs, setDisconnectingTabs] = useState<string[]>([]);
  const autoReconnectRef = useRef(state.autoReconnect !== false);
  autoReconnectRef.current = state.autoReconnect !== false;
  const showDisconnectReasonRef = useRef(state.showDisconnectReason !== false);
  showDisconnectReasonRef.current = state.showDisconnectReason !== false;
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const active = tabs.find((t) => t.id === activeID);
  const activeTerminalBackground = resolveTerminalTheme(theme, terminalTheme, active?.session.terminalTheme).background;
  const showSFTP = Boolean(active?.ref && active.status === "connected" && fileViews[activeID]);
  const aiPinned = aiSidebarMode === "pinned" && !showSFTP;
  const aiOpen = aiPinned || aiHoverOpen || aiFocusOpen;
  const notify = (error: unknown) => setToast(error);
  const quitPromptInProgress = useRef(false);
  const onQuitRequested = useRef<() => void>(() => {});
  onQuitRequested.current = () => {
    if (quitPromptInProgress.current) return;
    quitPromptInProgress.current = true;
    void (async () => {
      try {
        const activeTabs = tabsRef.current.filter(isActiveRemoteSession);
        if (activeTabs.length) {
          const busy = activeTabs.some(tab => hasInterruptibleWork(tab, hasActiveTransfers));
          const confirmed = await dialogs.confirm({
            title: message("common:quitActiveSessionsTitle"),
            description: message(busy
              ? "common:quitActiveSessionsBusyDescription"
              : "common:quitActiveSessionsDescription", { count: activeTabs.length }),
            preview: activeTabs.map(sessionLabel).join("\n"),
            tone: "warning",
            confirmLabel: message("common:quitAndDisconnect"),
          });
          if (!confirmed) return;
        }
        await api.QuitConfirmed();
      } catch (error) {
        notify(error);
      } finally {
        quitPromptInProgress.current = false;
      }
    })();
  };
  useEffect(() => {
    if (!desktop) return;
    const off = listen("app:quit-requested", () => onQuitRequested.current());
    void api.SetCloseGuardReady(true).catch(notify);
    return () => {
      off();
      void api.SetCloseGuardReady(false).catch(() => {});
    };
  }, []);

  const {
    layout, splitDirection, splitContainerRef, splitReady,
    visibleTabIDs, paneBoxes, splitHandles,
    applyDrop, undockPane, closeSplit, rotateActiveSplit,
    setSplitRatio, resizeNodeAndSave, startSplitResize,
  } = useSplitWorkspace({
    tabs, activeID, showSFTP, initialRatio: initialState.splitRatio, onError: notify,
  });
  const { unreadTabIDs, onRemoteOutput } = useTabActivity({ tabs, visibleTabIDs, hasActiveTransfers });
  const { splitDropPreview, onTabPointerMove, onTabPointerDrop, clearDropPreview } = useTabSplitDrop({
    tabs, layout, splitContainerRef, showSFTP, applyDrop, setActiveID, onError: notify,
  });

  const dropDialogs = useRef(dialogs);
  dropDialogs.current = dialogs;
  useEffect(() => {
    if (!desktop) return;
    return listen("app:files-dropped", ({ x, y, paths }: { x: number; y: number; paths: string[] }) => {
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
    });
  }, []);

  const refresh = async () => {
    try {
      const data = await api.State();
      setState(data);
      setTheme(data.theme === "light" ? "light" : "dark");
      setTerminalTheme(normalizeTerminalTheme(data.terminalTheme));
      setAutoCopySelection(data.autoCopySelection === true);
      setRightClickPaste(data.rightClickPaste === true);
      setConfirmMultilinePaste(data.confirmMultilinePaste !== false);
      setLogHighlights(data.logHighlights === true);
      setSplitRatio(Math.min(80, Math.max(20, data.splitRatio ?? 50)));
      if (data.fontSize)
        setFontSize(Math.max(11, Math.min(24, Number(data.fontSize) || 14)));
    } catch (e) {
      if (desktop) notify(e);
    }
  };
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
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
          retryCount: 0,
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
    return () => {
      off();
      lost();
      end();
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
      cloneCwd: t.everConnected ? undefined : t.cloneCwd,
      error: "",
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
        status: "connected", everConnected: true,
        home: result.home,
        cwd: result.home,
        cwdReported: false,
        error: "",
      }));
    } catch (e) {
      update(tab.id, (t) => t.manualDisconnected ? t : ({ ...t, status: "error", error: e }));
      if (!tabsRef.current.find(t => t.id === tab.id)?.manualDisconnected) notify(e);
    }
  };
  const open = (session: Session, afterTabID?: string, cloneCwd?: string) => {
    const tab: Tab = {
      id: id(),
      session,
      ref: null,
      status: "disconnected",
      home: "",
      cwd: "",
      cwdReported: false,
      cloneCwd,
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
  const { stopRetryTimer } = useAutoReconnect({
    tabs,
    tabsRef,
    update,
    enabled: state.autoReconnect !== false,
    maxReconnectAttempts: state.maxReconnectAttempts ?? 10,
    onChallenge: (host, tab) => setChallenge({ host, tab, secret: "" }),
  });
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
    if (disconnectInFlight.current.has(tab.id)) return;
    stopRetryTimer(tab.id);
    if (tab.session.authType === "password" && !tab.session.credentialRef) {
      setLogin({ tab, secret: "" });
    } else {
      void connect(tab);
    }
  };
  const disconnectTab = async (tab: Tab) => {
    if (disconnectInFlight.current.has(tab.id)) return;
    if (!tab.ref && tab.status !== "connecting" && tab.status !== "reconnecting") return;
    const hasTransfers = hasActiveTransfers(tab.ref);
    if (state.confirmActiveDisconnect !== false && hasTransfers) {
      if (!(await dialogs.confirm({
        title: message("common:disconnectRunningTitle"),
        description: message("common:disconnectRunningDescription"),
        tone: "warning",
        confirmLabel: message("common:disconnectAnyway"),
      }))) return;
    }
    disconnectInFlight.current.add(tab.id);
    setDisconnectingTabs([...disconnectInFlight.current]);
    try {
      stopRetryTimer(tab.id);
      update(tab.id, t => ({
        ...t, status: "disconnected", manualDisconnected: true,
        localFallbackPending: true,
        retryCount: 0,
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
      } catch (error) {
        notify(error);
      }
    } finally {
      disconnectInFlight.current.delete(tab.id);
      setDisconnectingTabs([...disconnectInFlight.current]);
    }
  };
  const closingTabs = useRef(new Set<string>());
  const close = async (tab: Tab) => {
    if (closingTabs.current.has(tab.id)) return;
    const initial = tabsRef.current.find(item => item.id === tab.id);
    if (!initial) return;
    closingTabs.current.add(tab.id);
    try {
      const active = isActiveRemoteSession(initial);
      const busy = hasInterruptibleWork(initial, hasActiveTransfers);
      if (active || busy) {
        const accepted = await dialogs.confirm({
          title: message(active ? "common:closeActiveSessionTitle" : "common:closeRunningTask"),
          description: message(active
            ? busy ? "common:closeActiveSessionBusyDescription" : "common:closeActiveSessionDescription"
            : "common:closeActiveSessionDescription", { name: initial.session.name }),
          preview: sessionLabel(initial),
          tone: "warning",
          confirmLabel: message(active ? "common:closeSessionAndDisconnect" : "common:closeAnyway"),
        });
        if (!accepted) return;
      }
      const current = tabsRef.current.find(item => item.id === tab.id);
      if (!current) return;
      // Do not close a new SSH connection using approval for an older generation.
      if (current.ref?.generation !== initial.ref?.generation ||
        (!active && isActiveRemoteSession(current))) return;
      stopRetryTimer(tab.id);
      await api.CloseTab(tab.id);
      setTabs((old) => old.filter((t) => t.id !== tab.id));
      if (activeIDRef.current === tab.id) {
        const rest = tabsRef.current.filter((t) => t.id !== tab.id);
        setActiveID(rest.at(-1)?.id ?? "");
      }
    } catch (e) {
      notify(e);
    } finally {
      closingTabs.current.delete(tab.id);
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
  const clearSidebarTimer = (timer: React.MutableRefObject<number | null>) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const scheduleSidebarClose = () => {
    clearSidebarTimer(sidebarOpenTimer);
    clearSidebarTimer(sidebarCloseTimer);
    if (sidebarMode !== "auto-hide") return;
    sidebarCloseTimer.current = window.setTimeout(() => {
      sidebarCloseTimer.current = null;
      if (sidebarHovered.current) return;
      if (sidebarKeyboardFocused.current &&
          sidebarDockRef.current?.contains(document.activeElement)) return;
      if (document.querySelector(".session-context-menu")) {
        scheduleSidebarClose();
        return;
      }
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && sidebarDockRef.current?.contains(focused) &&
          !focused.classList.contains("session-sidebar-rail")) {
        focused.blur();
      }
      setAutoSidebarOpen(false);
    }, 300);
  };
  const toggleSidebarMode = () => {
    const previous = sidebarMode;
    const next = previous === "pinned" ? "auto-hide" : "pinned";
    clearSidebarTimer(sidebarOpenTimer);
    clearSidebarTimer(sidebarCloseTimer);
    if (next === "auto-hide") setAutoSidebarOpen(true);
    setSidebarMode(next);
    void api.SavePreference("sessionSidebarMode", next).catch(error => {
      setSidebarMode(current => current === next ? previous : current);
      notify(error);
    });
  };
  useEffect(() => {
    if (sidebarMode === "pinned") setAutoSidebarOpen(false);
  }, [sidebarMode]);
  useEffect(() => () => {
    if (sidebarOpenTimer.current !== null) window.clearTimeout(sidebarOpenTimer.current);
    if (sidebarCloseTimer.current !== null) window.clearTimeout(sidebarCloseTimer.current);
  }, []);
  const drag = (event: React.PointerEvent) => {
    if (sidebarMode !== "pinned") return;
    const start = event.clientX;
    const width = sessionWidth;
    let current = width;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      current = Math.max(190, Math.min(360, width + e.clientX - start));
      setSessionWidth(current);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (current !== width) {
        void api.SavePreference("sessionSidebarWidth", String(current)).catch(notify);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  return (
    <div
      className="app"
      data-file-drop-target
      style={
        {
          "--session-width": `${sessionWidth}px`,
          "--ai-width": `${aiSidebarWidth}px`,
        } as React.CSSProperties
      }
    >
      <WindowTitleBar tabs={tabs}
        onSettings={() => setDialog({ kind: "settings" })}
        onNotice={notify} />
      <div className="app-body">
      <div
            ref={sidebarDockRef}
            className={`session-sidebar-dock ${sidebarMode === "auto-hide" ? "session-sidebar-dock--auto" : ""} ${autoSidebarOpen ? "is-open" : ""}`}
            onPointerDownCapture={() => {
              sidebarPointerFocused.current = true;
              sidebarKeyboardFocused.current = false;
            }}
            onMouseEnter={() => {
              sidebarHovered.current = true;
              clearSidebarTimer(sidebarCloseTimer);
              if (sidebarMode === "auto-hide") {
                clearSidebarTimer(sidebarOpenTimer);
                sidebarOpenTimer.current = window.setTimeout(() => {
                  sidebarOpenTimer.current = null;
                  setAutoSidebarOpen(true);
                }, 150);
              }
            }}
            onMouseLeave={() => {
              sidebarHovered.current = false;
              scheduleSidebarClose();
            }}
            onFocusCapture={event => {
              if (!sidebarPointerFocused.current) sidebarKeyboardFocused.current = true;
              if (sidebarMode === "auto-hide" &&
                  !(event.target as HTMLElement).classList.contains("session-sidebar-rail")) {
                clearSidebarTimer(sidebarOpenTimer);
                clearSidebarTimer(sidebarCloseTimer);
                setAutoSidebarOpen(true);
              }
            }}
            onBlurCapture={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                sidebarKeyboardFocused.current = false;
                sidebarPointerFocused.current = false;
                scheduleSidebarClose();
              }
            }}
            onKeyDownCapture={event => {
              if (event.key === "Tab" || event.key.startsWith("Arrow")) {
                sidebarPointerFocused.current = false;
                sidebarKeyboardFocused.current = true;
              }
            }}
            onKeyDown={event => {
              if (event.key === "Escape" && sidebarMode === "auto-hide") {
                event.preventDefault();
                event.stopPropagation();
                clearSidebarTimer(sidebarOpenTimer);
                clearSidebarTimer(sidebarCloseTimer);
                sidebarKeyboardFocused.current = false;
                sidebarPointerFocused.current = false;
                setAutoSidebarOpen(false);
                sidebarDockRef.current?.querySelector<HTMLButtonElement>(".session-sidebar-rail")?.focus();
              }
            }}
          >
            {sidebarMode === "auto-hide" && (
              <button
                type="button"
                className="session-sidebar-rail"
                aria-label={tr("sessions:showAutoHiddenSidebar")}
                title={tr("sessions:showAutoHiddenSidebar")}
                aria-controls="session-sidebar-panel"
                aria-expanded={autoSidebarOpen}
                onClick={() => {
                  clearSidebarTimer(sidebarOpenTimer);
                  clearSidebarTimer(sidebarCloseTimer);
                  setAutoSidebarOpen(true);
                }}
              />
            )}
          <SessionTree
            pinned={sidebarMode === "pinned"}
            detailsExpanded={detailsExpanded}
            onToggleDetails={() => {
              const next = !detailsExpanded;
              setDetailsExpanded(next);
              void api.SavePreference("sessionDetailsExpanded", String(next)).catch(error => {
                setDetailsExpanded(current => current === next ? !next : current);
                notify(error);
              });
            }}
            hidden={sidebarMode === "auto-hide" && !autoSidebarOpen}
            onTogglePin={toggleSidebarMode}
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
          />
          </div>
          {sidebarMode === "pinned" && (
            <div className="splitter" onPointerDown={drag} />
          )}
      <main className="workspace" onPointerDownCapture={() => {
        if (sidebarMode === "auto-hide" && autoSidebarOpen) {
          clearSidebarTimer(sidebarCloseTimer);
          setAutoSidebarOpen(false);
        }
      }}>
        <WorkspaceTabStrip tabs={tabs} activeID={activeID} unreadTabIDs={unreadTabIDs}
          disconnectBehavior={state.disconnectBehavior ?? "local"}
          onActivate={setActiveID}
          onDuplicate={tab => open(tab.session, tab.id,
            tab.status === "connected" && tab.cwdReported
              ? normalizeRemoteDirectory(tab.cwd) ?? undefined : undefined)}
          onClose={tab => { void close(tab); }}
          onNewTab={() => setShowSessionPicker(true)}
          onTabPointerMove={onTabPointerMove}
          onTabPointerDrop={onTabPointerDrop}
          onTabDragEnd={clearDropPreview}
          onDropOnStrip={undockPane}
          onReorder={(sourceID, targetID, placement) =>
            setTabs(current => reorderTabs(current, sourceID, targetID, placement))} />
        {!tabs.length ? (
          <div className="workspace-empty">
            <div className="terminal-emblem">
              <Terminal size={41} strokeWidth={1.3} />
              <span />
            </div>
            <span className="eyebrow">{tr("common:lighterConnection")}</span>
            <h1>{tr("common:connectYourServerGetToWork")}</h1>
            <p>
              {tr("common:doubleClickASessionOnTheLeftTo")}
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
                <FolderOpen size={15} />
                {tr("sftp:fileManager")}
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
                {splitReady && (
                  <>
                    <button title={tr("terminal:rotateSplit")} aria-label={tr("terminal:rotateSplit")}
                      onClick={rotateActiveSplit}>
                      {splitDirection === "columns" ? <Rows2 size={14} /> : <Columns2 size={14} />}
                    </button>
                    <button title={tr("terminal:closeSplit")} aria-label={tr("terminal:closeSplit")}
                      onClick={closeSplit}><X size={14} /></button>
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
                  onClick={() => {
                    if (!active) return;
                    setFileViews(old => ({ ...old, [active.id]: !old[active.id] }));
                  }}
                >
                  {showSFTP ? <PanelRightOpen size={14} /> : <FolderOpen size={14} />}
                </button>
                <button
                  title={tr(connectionActionLabel(active?.status))}
                  aria-label={tr(connectionActionLabel(active?.status))}
                  disabled={!active || disconnectingTabs.includes(active.id)}
                  onClick={() => {
                    if (!active) return;
                    if (["connected", "connecting", "reconnecting"].includes(active.status)) {
                      void disconnectTab(active);
                    } else {
                      manualConnect(active);
                    }
                  }}
                >
                  {active?.status === "connected" ? <Unplug size={14} /> :
                    active?.status === "connecting" || active?.status === "reconnecting"
                      ? <X size={14} /> : <RefreshCw size={14} />}
                </button>
              </div>
            </div>
            <div className={`workspace-workarea ${showSFTP ? "with-sftp" : ""}`}>
            <div ref={splitContainerRef}
              className={`terminal-container ${splitReady ? `terminal-split terminal-split-${splitDirection}` : ""}`}
              style={{ "--terminal-background": activeTerminalBackground } as CSSProperties}>
              {tabs.map((tab) => (
                <TerminalPane
                  key={tab.id}
                  tab={tab}
                  disconnectBehavior={state.disconnectBehavior ?? "local"}
                  localShell={state.localShell ?? "powershell"}
                  preserveHistory={state.preserveTerminalHistory !== false}
                  showDisconnectReason={state.showDisconnectReason !== false}
                  active={tab.id === activeID}
                  visible={visibleTabIDs.includes(tab.id)}
                  paneBounds={splitReady ? paneBoxes[tab.id] : undefined}
                  onUndock={splitReady ? () => {
                    undockPane(tab.id);
                    if (activeID === tab.id) {
                      setActiveID(visibleTabIDs.find(id => id !== tab.id) ?? activeID);
                    }
                  } : undefined}
                  onActivate={() => setActiveID(tab.id)}
                  aiControlled={Boolean(tab.ref && aiTerminalControls[tab.id]?.generation === tab.ref.generation)}
                  onTakeControl={() => {
                    const task = aiTerminalControls[tab.id];
                    if (task) void api.AIStop(task.taskId).catch(notify);
                  }}
                  onAlternateScreenChange={(ref, alternate) => {
                    const current = tabsRef.current.find(item => item.id === ref.tabId);
                    if (!current?.ref || current.ref.generation !== ref.generation) return;
                    setAlternateTerminals(previous => {
                      const existing = previous[ref.tabId];
                      if (existing?.generation === ref.generation && existing.active === alternate) return previous;
                      return { ...previous, [ref.tabId]: { generation: ref.generation, active: alternate } };
                    });
                  }}
                  onRemoteOutput={onRemoteOutput}
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
                  logHighlights={logHighlights}
                  confirmMultilinePaste={confirmMultilinePaste}
                  onNotice={notify}
                  commandFocusVersion={quickCommandFocus}
                  searchFocusVersion={terminalSearchFocus}
                  transferFocusRequest={transferFocusRequest ?? undefined}
                  onError={(text) => {
                    update(tab.id, (t) => ({
                      ...t,
                      status: "error",
                      error: text,
                    }));
                    if (tab.ref) api.Disconnect(tab.ref).catch(() => {});
                    notify(text);
                  }}
                />
              ))}
              {splitDropPreview && (
                <div className={`terminal-split-drop-preview terminal-split-drop-${splitDropPreview.intent.zone} ${splitDropPreview.intent.mode === "smart" ? "is-smart" : ""} ${splitDropPreview.invalid ? "is-invalid" : ""}`}
                  style={{
                    left: splitDropPreview.left, top: splitDropPreview.top,
                    width: splitDropPreview.width, height: splitDropPreview.height,
                  }} aria-hidden="true">
                  <span>{splitDropPreview.invalid
                    ? tr("terminal:splitPaneLimit")
                    : splitDropPreview.intent.mode === "smart"
                    ? tr("terminal:dropSplitSmart")
                    : tr(({
                      left: "terminal:dropSplitLeft", right: "terminal:dropSplitRight",
                      top: "terminal:dropSplitTop", bottom: "terminal:dropSplitBottom",
                    } as const)[splitDropPreview.intent.zone])}</span>
                </div>
              )}
              {splitReady && splitHandles.map(handle => (
                <div key={handle.id} className="terminal-split-handle"
                  style={{ left: handle.left, top: handle.top, width: handle.width, height: handle.height }}
                  role="separator" tabIndex={0}
                  aria-label={tr("terminal:resizeSplit")}
                  aria-orientation={handle.direction === "columns" ? "vertical" : "horizontal"}
                  aria-valuemin={20} aria-valuemax={80} aria-valuenow={handle.ratio}
                  title={tr("terminal:resetSplitRatio")}
                  onPointerDown={event => startSplitResize(event, handle)}
                  onDoubleClick={() => resizeNodeAndSave(handle.id, 50)}
                  onKeyDown={event => {
                    const increment = event.shiftKey ? 10 : 5;
                    if (event.key === "Home" || event.key === "End") {
                      event.preventDefault();
                      resizeNodeAndSave(handle.id, event.key === "Home" ? 20 : 80);
                    } else if (
                      (handle.direction === "columns" && ["ArrowLeft", "ArrowRight"].includes(event.key)) ||
                      (handle.direction === "rows" && ["ArrowUp", "ArrowDown"].includes(event.key))
                    ) {
                      event.preventDefault();
                      resizeNodeAndSave(handle.id,
                        handle.ratio + (["ArrowRight", "ArrowDown"].includes(event.key) ? increment : -increment));
                    }
                  }}
                />
              ))}
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
                    <SFTPView refID={tab.ref!} onNotice={notify}
                      initialRemoteDirectory={tab.cwdReported ? tab.cwd : tab.cloneCwd ?? tab.cwd}
                      cwdReported={tab.cwdReported === true}
                      onRemoteDirectoryChange={directory => {
                        remoteUploadDirs.current[tab.id] = directory;
                      }} hideTaskQueue />
                  )}

                </aside>
              );
            })}
            </div>
            {(
              <QuickCommandBar
                tab={active}
                commands={state.quickCommands ?? []}
                onManage={() => setShowQuickCommandManager(true)}
                onRun={runQuickCommand}
              />
            )}
          </>
        )}
      </main>
      <div className={`ai-dock ${!aiPinned ? "ai-dock--auto" : ""} ${aiOpen ? "is-open" : ""}`}
          onMouseEnter={() => {
            if (aiCloseTimer.current !== null) window.clearTimeout(aiCloseTimer.current);
            if (aiHoverTimer.current !== null) window.clearTimeout(aiHoverTimer.current);
            aiHoverTimer.current = window.setTimeout(() => setAIHoverOpen(true), 150);
          }}
          onMouseLeave={() => {
            if (aiHoverTimer.current !== null) window.clearTimeout(aiHoverTimer.current);
            aiCloseTimer.current = window.setTimeout(() => setAIHoverOpen(false), 250);
          }}
          onFocusCapture={() => setAIFocusOpen(true)}
          onBlurCapture={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAIFocusOpen(false);
          }}
          onKeyDown={event => {
            if (event.key === "Escape" && !aiPinned) {
              setAIHoverOpen(false);
              setAIFocusOpen(false);
              (event.currentTarget.querySelector(".ai-rail") as HTMLButtonElement | null)?.focus();
            }
          }}
        >
          {!aiPinned && (
            <button className="ai-rail" title={tr("ai:expandAiAssistant")} aria-label={tr("ai:expandAiAssistant")}
              aria-expanded={aiOpen} onClick={() => setAIHoverOpen(true)} />
          )}
          {aiPinned && <div className="ai-dock-splitter" onPointerDown={startAIResize} role="separator" aria-label={tr("ai:resizeAiSidebar")} />}
          <AISidebar tabs={tabs} active={active} pinned={aiSidebarMode === "pinned"} isOpen={aiOpen}
            terminalAlternate={Boolean(active?.ref && alternateTerminals[activeID]?.generation === active.ref.generation && alternateTerminals[activeID]?.active)}
            onTogglePin={toggleAIPin} onClose={closeAI} />
        </div>
      </div>
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
          language={language}
          languageSaving={languageSaving}
          onLanguage={changeLanguage}
          fontSize={fontSize}
          theme={theme}
          onTheme={setTheme}
          terminalTheme={terminalTheme}
          onTerminalTheme={setTerminalTheme}
          autoCopySelection={autoCopySelection}
          onAutoCopySelection={setAutoCopySelection}
          rightClickPaste={rightClickPaste}
          onRightClickPaste={setRightClickPaste}
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
        <ModalSurface
          className="compact-dialog"
          aria-label={tr("common:connect")}
          onDismiss={() => setLogin(null)}
        >
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
        </ModalSurface>
      )}
      {challenge && (
        <ModalSurface
          className="compact-dialog"
          aria-label={challenge.host.changed ? tr("common:serverFingerprintChanged") : tr("common:verifyServerFingerprint")}
          onDismiss={() => setChallenge(null)}
          closeOnBackdrop={false}
        >
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
        </ModalSurface>
      )}
      <ZmodemFilePicker activeRef={active?.ref ?? undefined} onNotice={notify}
        onClosed={ref => setTransferFocusRequest({ ref })} />
       
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
