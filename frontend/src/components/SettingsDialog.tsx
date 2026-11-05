import { renderMessage, type DisplayText } from "../i18n/message";
import { useTranslation } from "react-i18next";
import { message } from "../i18n/message";
import { t } from "../i18n";
import type { Language } from "../i18n/languages";
import { useRef, useState } from "react";
import {
  X,
  Server,
  Network,
  Settings2,
  Palette,
  Sparkles,
  Info,
  Activity,
  Terminal,
  FolderOpen,
  Plus,
  Trash2,
  Check,
  LoaderCircle,
} from "lucide-react";
import { api, errorText } from "../bridge";
import ModalSurface from "./ModalSurface";
import { useDialogs } from "./DialogProvider";
import GeneralSettingsPanel from "./GeneralSettingsPanel";
import AppearanceSettingsPanel from "./AppearanceSettingsPanel";
import ConnectionSettingsPanel from "./ConnectionSettingsPanel";
import TerminalSettingsPanel from "./TerminalSettingsPanel";
import AIProviderSettings from "./AIProviderSettings";
import SFTPEditorSettingsPanel from "./editor/SFTPEditorSettingsPanel";
import AboutSettingsPanel from "./AboutSettingsPanel";
import DiagnosticsSettingsPanel from "./DiagnosticsSettingsPanel";
import type {
  Session,
  LocalForward,
  Group,
  SessionRequest,
  Theme,
  TerminalTheme,
} from "../types";
interface Props {
  language?: Language;
  languageSaving?: boolean;
  onLanguage?(language: Language): Promise<void>;
  kind: "session" | "settings";
  initialTab?: "ai";
  session?: Session;
  sessionConnected?: boolean;
  groupID?: string;
  groups: Group[];
  fontSize: number;
  theme: Theme;
  onTheme(theme: Theme): void;
  terminalTheme: TerminalTheme;
  onTerminalTheme(theme: TerminalTheme): void;
  autoCopySelection: boolean;
  onAutoCopySelection(enabled: boolean): void;
  rightClickPaste: boolean;
  onRightClickPaste(enabled: boolean): void;
  confirmMultilinePaste: boolean;
  logHighlights: boolean;
  keepAliveSeconds?: number;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  showDisconnectReason?: boolean;
  confirmActiveDisconnect?: boolean;
  disconnectBehavior?: import("../types").DisconnectBehavior;
  localShell?: import("../types").LocalShell;
  preserveTerminalHistory?: boolean;
  onLogHighlights(enabled: boolean): void;
  onConfirmMultilinePaste(enabled: boolean): void;
  onClose(): void;
  onSession(req: SessionRequest): Promise<void>;
  onExportSessionBackup?(): Promise<void>;
  onImportSessionBackup?(): Promise<void>;
  onRefresh(): Promise<void>;
  onFont(n: number): void;
  onPreferenceError?(error: unknown): void;
}
const emptySession: Session = {
  id: "",
  groupId: "",
  name: "",
  host: "",
  port: 22,
  username: "root",
  authType: "password",
  privateKeyPath: "",
  credentialRef: "",
};
export default function SettingsDialog(p: Props) {
  useTranslation();
  const dialogs = useDialogs();
  const [tab, setTab] = useState(
    p.kind === "session" ? "session" : (p.initialTab ?? "general"),
  );
  const [session, setSession] = useState({
    ...emptySession,
    groupId: p.groupID ?? "",
    ...p.session,
  });
  const initialSession = useRef(session);
  const [keepAliveSeconds, setKeepAliveSeconds] = useState(p.keepAliveSeconds ?? 30);
  const [autoReconnect, setAutoReconnect] = useState(p.autoReconnect !== false);
  const [maxReconnectAttempts, setMaxReconnectAttempts] = useState(p.maxReconnectAttempts ?? 10);
  const [showDisconnectReason, setShowDisconnectReason] = useState(p.showDisconnectReason !== false);
  const [confirmActiveDisconnect, setConfirmActiveDisconnect] = useState(p.confirmActiveDisconnect !== false);
  const [disconnectBehavior, setDisconnectBehavior] = useState(p.disconnectBehavior ?? "local");
  const [localShell, setLocalShell] = useState(p.localShell ?? "powershell");
  const [preserveTerminalHistory, setPreserveTerminalHistory] = useState(p.preserveTerminalHistory !== false);
  const [secret, setSecret] = useState("");
  const [saveSecret, setSaveSecret] = useState(!!p.session?.credentialRef);
  const [error, setError] = useState<unknown>("");
  const [success, setSuccess] = useState<DisplayText>("");
  const [busy, setBusy] = useState(false);
  const [aiDirty, setAiDirty] = useState(false);
  const preferenceQueue = useRef<Promise<void>>(Promise.resolve());
  const fontSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFontSize = useRef<number | null>(null);
  const persistPreference = (key: string, value: string, refresh = false) => {
    setError("");
    preferenceQueue.current = preferenceQueue.current
      .then(async () => {
        await api.SavePreference(key, value);
        if (refresh) await p.onRefresh();
      })
      .catch((error) => {
        setError(error);
        p.onPreferenceError?.(error);
      });
  };
  const flushFontSave = () => {
    if (fontSaveTimer.current !== null) {
      clearTimeout(fontSaveTimer.current);
      fontSaveTimer.current = null;
    }
    if (pendingFontSize.current === null) return;
    const size = pendingFontSize.current;
    pendingFontSize.current = null;
    persistPreference("fontSize", String(size));
  };
  const changeFont = (size: number) => {
    p.onFont(size);
    pendingFontSize.current = size;
    if (fontSaveTimer.current !== null) clearTimeout(fontSaveTimer.current);
    fontSaveTimer.current = setTimeout(flushFontSave, 300);
  };
  const confirmDiscardAI = () => dialogs.confirm({
    title: message("settings:aiUnsavedChangesTitle"),
    description: message("settings:aiUnsavedChangesDescription"),
    confirmLabel: message("settings:discardSessionChanges"),
    cancelLabel: message("settings:continueEditing"),
    tone: "warning",
  });
  const selectSettingsTab = (next: string) => {
    if (next === tab) return;
    const apply = () => {
      setTab(next);
      setAiDirty(false);
      setError("");
      setSuccess("");
    };
    if (tab === "ai" && aiDirty) {
      void confirmDiscardAI().then(confirmed => { if (confirmed) apply(); });
      return;
    }
    apply();
  };
  const sessionDirty = JSON.stringify(session) !== JSON.stringify(initialSession.current) ||
    secret !== "" || saveSecret !== !!p.session?.credentialRef;
  const requestClose = () => {
    if (busy) return;
    if (p.kind === "settings") {
      flushFontSave();
      if (aiDirty) {
        void confirmDiscardAI().then(confirmed => { if (confirmed) p.onClose(); });
      } else {
        p.onClose();
      }
      return;
    }
    if (!sessionDirty) {
      p.onClose();
      return;
    }
    void dialogs.confirm({
      title: message("settings:unsavedSessionChangesTitle"),
      description: message("settings:unsavedSessionChangesDescription"),
      confirmLabel: message("settings:discardSessionChanges"),
      cancelLabel: message("settings:continueEditing"),
      tone: "warning",
    }).then((discard) => {
      if (discard) p.onClose();
    });
  };
  const groupPath = (g: Group): string => {
    const names = [g.name];
    const seen = new Set([g.id]);
    let parent = g.parentId;
    while (parent && !seen.has(parent)) {
      const item = p.groups.find((entry) => entry.id === parent);
      if (!item) break;
      names.unshift(item.name);
      seen.add(parent);
      parent = item.parentId;
    }
    return names.join(" / ");
  };
  const field = (name: keyof Session, value: string | number | boolean) =>
    setSession({ ...session, [name]: value });
  const updateForward = (index: number, update: Partial<LocalForward>) => {
    setSession((current) => ({
      ...current,
      localForwards: (current.localForwards ?? []).map((forward, i) =>
        i === index ? { ...forward, ...update } : forward,
      ),
    }));
  };
  const run = async (fn: () => Promise<void>, message: DisplayText = "") => {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await fn();
      setSuccess(message);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalSurface
      className={`settings-dialog settings-dialog--${p.kind}`}
      aria-label={p.kind === "session" ? t(p.session ? "common:editSession" : "common:newSshSession") : t("settings:settingsTitle")}
      onDismiss={requestClose}
      closeOnBackdrop={p.kind !== "session"}
      locked={busy}
    >
        <header>
          <div>
            <h2>
              {p.kind === "session"
                ? p.session
                  ? t("common:editSession")
                  : t("common:newSshSession")
                : t("settings:settingsTitle")}
            </h2>
          </div>
          <button title={t("common:close")} disabled={busy} onClick={requestClose}>
            <X size={19} />
          </button>
        </header>
        <div className="settings-layout">
          {p.kind === "settings" && (
            <nav className="settings-sidebar" aria-label={t("settings:settingsNavigation")}>
              {[
                { id: "general", label: t("settings:general"), icon: Settings2 },
                { id: "appearance", label: t("settings:appearance"), icon: Palette },
                { id: "terminal", label: t("settings:terminal"), icon: Terminal },
                { id: "sftp", label: "SFTP", icon: FolderOpen },
                { id: "connection", label: t("settings:connection"), icon: Network },
                { id: "ai", label: t("settings:aiSettings"), icon: Sparkles },
                { id: "diagnostics", label: t("settings:diagnostics"), icon: Activity },
                { id: "about", label: t("settings:about"), icon: Info },
              ].map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={tab === id ? "active" : ""}
                  aria-current={tab === id ? "page" : undefined}
                  onClick={() => selectSettingsTab(id)}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
            </nav>
          )}
        <div className="settings-body">
          {p.kind === "settings" && !!error && (
            <div className="form-error settings-save-error" role="alert">{errorText(error)}</div>
          )}
          {tab === "session" && (
            <>
              <div className="form-note">
                <Server size={17} />
                <span>
                  {t(
                    p.sessionConnected
                      ? "settings:connectedSessionEditingNotice"
                      : "settings:saveConnectionDetailsThenDoubleClickASession",
                  )}
                </span>
              </div>
              <label>
                {t("settings:sessionName")}
                <input
                  value={session.name}
                  onChange={(e) => field("name", e.target.value)}
                  placeholder={t("settings:eGHongKongServer")}
                />
              </label>
              <div className="form-row">
                <label className="flex-grow">
                  {t("common:host")}
                  <input
                    autoFocus
                    value={session.host}
                    onChange={(e) => field("host", e.target.value)}
                    placeholder={t("settings:ipAddressOrHostname")}
                  />
                </label>
                <label className="port-field">
                  {t("common:port")}
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    value={session.port}
                    onChange={(e) => field("port", Number(e.target.value))}
                  />
                </label>
              </div>
              <div className="form-row">
                <label>
                  {t("common:username")}
                  <input
                    value={session.username}
                    onChange={(e) => field("username", e.target.value)}
                  />
                </label>
                <label>
                  {t("common:folder")}
                  <select
                    value={session.groupId}
                    onChange={(e) => field("groupId", e.target.value)}
                  >
                    <option value="">{t("common:defaultFolder")}</option>
                    {p.groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {groupPath(g)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                {t("settings:sessionTerminalTheme")}
                <select
                  value={session.terminalTheme ?? "follow"}
                  onChange={(e) => field("terminalTheme", e.target.value)}
                >
                  <option value="follow">{t("settings:useGlobalTerminalTheme")}</option>
                  <option value="classic">{t("settings:terminalThemeClassic")}</option>
                  <option value="dark">{t("settings:terminalThemeDark")}</option>
                  <option value="light">{t("settings:terminalThemeLight")}</option>
                </select>
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={session.useSSHConfig ?? false}
                  onChange={(e) => field("useSSHConfig", e.target.checked)}
                />
                {t("settings:useOpenSSHConfig")}
              </label>
              <p className="muted small">{t("settings:useOpenSSHConfigDescription")}</p>
              <label>
                {t("settings:proxyJump")}
                <input
                  value={session.proxyJump ?? ""}
                  onChange={(e) => field("proxyJump", e.target.value)}
                  placeholder="user@bastion.example.com:22"
                />
              </label>
              <p className="muted small">{t("settings:proxyJumpDescription")}</p>
              <div className="settings-panel-heading">
                <h3>{t("settings:localForwards")}</h3>
                <p>{t("settings:localForwardsDescription")}</p>
              </div>
              {(session.localForwards ?? []).map((forward, index) => (
                <div key={index} className="form-row">
                  <input
                    aria-label={t("settings:forwardBindHost")}
                    value={forward.bindHost}
                    onChange={(e) => updateForward(index, { bindHost: e.target.value })}
                    placeholder="127.0.0.1"
                  />
                  <input
                    type="number" min="1" max="65535"
                    aria-label={t("settings:forwardBindPort")}
                    value={forward.bindPort}
                    onChange={(e) => updateForward(index, { bindPort: Number(e.target.value) })}
                    placeholder="8080"
                  />
                  <input
                    aria-label={t("settings:forwardTargetHost")}
                    value={forward.targetHost}
                    onChange={(e) => updateForward(index, { targetHost: e.target.value })}
                    placeholder="127.0.0.1"
                  />
                  <input
                    type="number" min="1" max="65535"
                    aria-label={t("settings:forwardTargetPort")}
                    value={forward.targetPort}
                    onChange={(e) => updateForward(index, { targetPort: Number(e.target.value) })}
                    placeholder="80"
                  />
                  <button
                    type="button"
                    title={t("settings:removeForward")}
                    onClick={() => setSession((current) => ({
                      ...current,
                      localForwards: (current.localForwards ?? []).filter((_, i) => i !== index),
                    }))}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              {(session.localForwards ?? []).length < 8 && (
                <button type="button" onClick={() => setSession((current) => ({
                  ...current,
                  localForwards: [...(current.localForwards ?? []), {
                    bindHost: "127.0.0.1", bindPort: 8080,
                    targetHost: "127.0.0.1", targetPort: 80,
                  }],
                }))}>
                  <Plus size={15} /> {t("settings:addForward")}
                </button>
              )}
              <label>
                {t("common:authentication")}
                <select
                  value={session.authType}
                  onChange={(e) => {
                    field("authType", e.target.value);
                    setSecret("");
                    setSaveSecret(false);
                  }}
                >
                  <option value="password">{t("common:password2")}</option>
                  <option value="key">{t("settings:privateKey")}</option>
                  <option value="agent">{t("settings:sshAgent")}</option>
                </select>
              </label>
              {session.authType === "key" && (
                <label>
                  {t("settings:privateKeyFile")}
                  <div className="input-with-button">
                    <input
                      value={session.privateKeyPath}
                      onChange={(e) => field("privateKeyPath", e.target.value)}
                      placeholder={t("settings:chooseALocalPrivateKey")}
                    />
                    <button
                      title={t("settings:choosePrivateKeyFile")}
                      onClick={() =>
                        run(async () => {
                          const path = await api.ChoosePrivateKey();
                          if (path) field("privateKeyPath", path);
                        })
                      }
                    >
                      <FolderOpen size={17} />
                    </button>
                  </div>
                </label>
              )}
              {session.authType !== "agent" && <label>
                {session.authType === "key"
                  ? t("settings:keyPassphraseOptional")
                  : t("common:password")}
                <input
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={
                    session.credentialRef
                      ? t("settings:credentialsSavedLeaveEmptyToKeepThem")
                      : t("settings:enterWhenConnectingIfNotSaved")
                  }
                />
              </label>}
              {session.authType !== "agent" && <label className="checkbox">
                <input
                  type="checkbox"
                  checked={saveSecret}
                  onChange={(e) => setSaveSecret(e.target.checked)}
                />
                {t("settings:saveToWindowsCredentialManager")}
              </label>}
              <p className="muted small">
                {t(session.authType === "agent" ? "settings:sshAgentDescription" : "settings:passwordsAndKeyPassphrasesAreNotStoredIn")}
              </p>
            </>
          )}
          {tab === "general" && (
            <GeneralSettingsPanel
              language={p.language}
              languageSaving={p.languageSaving}
              onLanguage={p.onLanguage}
              onLanguageError={setError}
              onExportSessionBackup={p.onExportSessionBackup}
              onImportSessionBackup={p.onImportSessionBackup}
            />
          )}
          {tab === "appearance" && (
            <AppearanceSettingsPanel
              theme={p.theme}
              onTheme={(value) => { p.onTheme(value); persistPreference("theme", value); }}
              terminalTheme={p.terminalTheme}
              onTerminalTheme={(value) => { p.onTerminalTheme(value); persistPreference("terminalTheme", value); }}
              fontSize={p.fontSize}
              onFont={changeFont}
            />
          )}
          {tab === "ai" && <AIProviderSettings onDirtyChange={setAiDirty} />}
          {tab === "sftp" && <SFTPEditorSettingsPanel />}
          {tab === "diagnostics" && <DiagnosticsSettingsPanel />}
          {tab === "about" && <AboutSettingsPanel />}
          {tab === "connection" && (
            <ConnectionSettingsPanel
              keepAliveSeconds={keepAliveSeconds}
              setKeepAliveSeconds={(value) => { setKeepAliveSeconds(value); persistPreference("keepAliveSeconds", String(value), true); }}
              autoReconnect={autoReconnect}
              setAutoReconnect={(value) => { setAutoReconnect(value); persistPreference("autoReconnect", String(value), true); }}
              maxReconnectAttempts={maxReconnectAttempts}
              setMaxReconnectAttempts={(value) => { setMaxReconnectAttempts(value); persistPreference("maxReconnectAttempts", String(value), true); }}
              showDisconnectReason={showDisconnectReason}
              setShowDisconnectReason={(value) => { setShowDisconnectReason(value); persistPreference("showDisconnectReason", String(value), true); }}
              disconnectBehavior={disconnectBehavior}
              setDisconnectBehavior={(value) => { setDisconnectBehavior(value); persistPreference("disconnectBehavior", value, true); }}
              localShell={localShell}
              setLocalShell={(value) => { setLocalShell(value); persistPreference("localShell", value, true); }}
              preserveTerminalHistory={preserveTerminalHistory}
              setPreserveTerminalHistory={(value) => { setPreserveTerminalHistory(value); persistPreference("preserveTerminalHistory", String(value), true); }}
              confirmActiveDisconnect={confirmActiveDisconnect}
              setConfirmActiveDisconnect={(value) => { setConfirmActiveDisconnect(value); persistPreference("confirmActiveDisconnect", String(value), true); }}
            />
          )}
          {tab === "terminal" && (
            <TerminalSettingsPanel
              logHighlights={p.logHighlights}
              onLogHighlights={(value) => { p.onLogHighlights(value); persistPreference("logHighlights", String(value)); }}
              autoCopySelection={p.autoCopySelection}
              onAutoCopySelection={(value) => { p.onAutoCopySelection(value); persistPreference("autoCopySelection", String(value)); }}
              rightClickPaste={p.rightClickPaste}
              onRightClickPaste={(value) => { p.onRightClickPaste(value); persistPreference("rightClickPaste", String(value)); }}
              confirmMultilinePaste={p.confirmMultilinePaste}
              onConfirmMultilinePaste={(value) => { p.onConfirmMultilinePaste(value); persistPreference("confirmMultilinePaste", String(value)); }}
            />
          )}
          {p.kind === "session" && !!error && (
            <div className="form-error" role="alert">
              {errorText(error)}
            </div>
          )}
          {success && (
            <div className="form-success">
              <Check size={15} />
              {renderMessage(success)}
            </div>
          )}
        </div>
        </div>
        {p.kind === "session" && (
          <footer>
            <button className="secondary" disabled={busy} onClick={requestClose}>
              {t("common:close")}
            </button>
            <div>
            {tab === "session" && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  if (!session.host.trim() || !session.username.trim()) {
                    setError(message("settings:enterAHostAndUsername"));
                    return;
                  }
                  if (session.port < 1 || session.port > 65535) {
                    setError(message("settings:portMustBeBetween1And65535"));
                    return;
                  }
                  if (session.authType === "key" && !session.privateKeyPath && !session.useSSHConfig) {
                    setError(message("settings:chooseAPrivateKeyFile"));
                    return;
                  }
                  run(async () => {
                    await p.onSession({ session, secret, saveSecret });
                    p.onClose();
                  });
                }}
              >
                {busy ? <LoaderCircle size={15} className="spin" /> : null}
                {t("settings:saveSession")}
              </button>
            )}
            </div>
          </footer>
        )}
    </ModalSurface>
  );
}
