import { renderMessage, type DisplayText } from "../i18n/message";
import { useTranslation } from "react-i18next";
import { message } from "../i18n/message";
import { t } from "../i18n";
import { languages, type Language } from "../i18n/languages";
import { useState } from "react";
import {
  X,
  Server,
  KeyRound,
  Settings2,
  Terminal,
  Bot,
  ShieldCheck,
  Sun,
  Moon,
  FolderOpen,
  Plus,
  Trash2,
  Check,
  LoaderCircle,
} from "lucide-react";
import { api, errorText } from "../bridge";
import { useDialogs } from "./DialogProvider";
import type {
  Session,
  Group,
  APIProfile,
  SessionRequest,
  APIRequest,
  Theme,
  QuickCommandLayout,
} from "../types";
interface Props {
  language?: Language;
  languageSaving?: boolean;
  onLanguage?(language: Language): Promise<void>;
  kind: "session" | "settings";
  session?: Session;
  sessionConnected?: boolean;
  groupID?: string;
  groups: Group[];
  profiles: APIProfile[];
  fontSize: number;
  autoCommandLimit?: number;
  autoAllowChanges?: boolean;
  saveChatHistory?: boolean;
  autoSummarize?: boolean;
  theme: Theme;
  onTheme(theme: Theme): void;
  quickCommandLayout: QuickCommandLayout;
  onQuickCommandLayout(layout: QuickCommandLayout): void;
  autoCopySelection: boolean;
  onAutoCopySelection(enabled: boolean): void;
  rightClickPaste: boolean;
  onRightClickPaste(enabled: boolean): void;
  confirmMultilinePaste: boolean;
  onConfirmMultilinePaste(enabled: boolean): void;
  onClose(): void;
  onSession(req: SessionRequest): Promise<void>;
  onExportSessionBackup?(): Promise<void>;
  onImportSessionBackup?(): Promise<void>;
  onRefresh(): Promise<void>;
  onFont(n: number): void;
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
const emptyProfile: APIProfile = {
  id: "",
  name: "",
  baseUrl: "",
  model: "",
  secretRef: "",
  toolsEnabled: true,
};
export default function SettingsDialog(p: Props) {
  useTranslation();
  const dialogs = useDialogs();
  const [tab, setTab] = useState(
    p.kind === "session" ? "session" : "general",
  );
  const [session, setSession] = useState({
    ...emptySession,
    groupId: p.groupID ?? "",
    ...p.session,
  });
  const [autoLimit, setAutoLimit] = useState(p.autoCommandLimit ?? 10);
  const [allowChanges, setAllowChanges] = useState(p.autoAllowChanges ?? false);
  const [secret, setSecret] = useState("");
  const [saveSecret, setSaveSecret] = useState(!!p.session?.credentialRef);
  const [profile, setProfile] = useState<APIProfile>(
    p.profiles[0]
      ? { ...p.profiles[0] }
      : { ...emptyProfile },
  );
  const [key, setKey] = useState("");
  const [memoryOnly, setMemoryOnly] = useState(false);
  const [error, setError] = useState<unknown>("");
  const [success, setSuccess] = useState<DisplayText>("");
  const [busy, setBusy] = useState(false);
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
  const field = (name: keyof Session, value: string | number) =>
    setSession({ ...session, [name]: value });
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
  const apiRequest = (): APIRequest => ({ profile, key, memoryOnly });
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) p.onClose();
      }}
    >
      <section role="dialog" aria-modal="true" className={`settings-dialog settings-dialog--${p.kind}`}>
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
          <button title={t("common:close")} disabled={busy} onClick={p.onClose}>
            <X size={19} />
          </button>
        </header>
        <div className="settings-layout">
          {p.kind === "settings" && (
            <nav className="settings-sidebar" aria-label={t("settings:settingsNavigation")}>
              {[
                { id: "general", label: t("settings:general"), icon: Settings2 },
                { id: "terminal", label: t("settings:terminal"), icon: Terminal },
                { id: "api", label: t("settings:aiSettings"), icon: Bot },
                { id: "automatic", label: t("ai:automatic"), icon: ShieldCheck },
              ].map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={tab === id ? "active" : ""}
                  aria-current={tab === id ? "page" : undefined}
                  onClick={() => {
                    setTab(id);
                    setError("");
                    setSuccess("");
                  }}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
            </nav>
          )}
        <div className="settings-body">
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
              <label>
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
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={saveSecret}
                  onChange={(e) => setSaveSecret(e.target.checked)}
                />
                {t("settings:saveToWindowsCredentialManager")}
              </label>
              <p className="muted small">
                {t("settings:passwordsAndKeyPassphrasesAreNotStoredIn")}
              </p>
            </>
          )}
          {tab === "api" && (
            <section className="settings-panel" aria-labelledby="settings-api-title">
              <div className="settings-panel-heading">
                <h3 id="settings-api-title">{t("settings:aiSettings")}</h3>
                <p>{t("settings:aiDescription")}</p>
              </div>
              <div className="settings-memory">
                  <label>
                    <input
                      type="checkbox"
                      checked={p.saveChatHistory !== false}
                      disabled={busy}
                      onChange={(e) =>
                        void run(async () => {
                          await api.SavePreference(
                            "saveChatHistory",
                            String(e.target.checked),
                          );
                          await p.onRefresh();
                        })
                      }
                    />
                    {t("settings:saveChatHistory")}
                  </label>
                  <p className="muted small">
                    {t("settings:memoryDescription")}
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={p.autoSummarize !== false}
                      disabled={busy}
                      onChange={(e) =>
                        void run(async () => {
                          await api.SavePreference(
                            "autoSummarize",
                            String(e.target.checked),
                          );
                          await p.onRefresh();
                        })
                      }
                    />
                    {t("settings:autoSummarize")}
                  </label>
                  <p className="muted small">
                    {t("settings:summaryDescription")}
                  </p>
                </div>
                <div className="api-presets">
                <select
                  aria-label={t("settings:apiProfile")}
                  value={profile.id}
                  onChange={(e) => {
                    setProfile({
                      ...p.profiles.find((v) => v.id === e.target.value)!,
                    });
                    setKey("");
                    setError("");
                    setSuccess("");
                  }}
                >
                  {!profile.id && (
                    <option value="">{t("settings:newProfile")}</option>
                  )}
                  {p.profiles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
                <button
                  title={t("settings:newApiProfile")}
                  onClick={() => {
                    setProfile({ ...emptyProfile });
                    setKey("");
                    setError("");
                    setSuccess("");
                  }}
                >
                  <Plus size={17} />
                </button>
                {profile.id && (
                  <button
                    title={t("settings:deleteApiProfile")}
                    onClick={async () => {
                      if (
                        !(await dialogs.confirm({
                          title: message("settings:deleteAiApiProfile"),
                          description: message(
                            "settings:deleteThisApiProfileAndItsSavedKey",
                          ),
                          tone: "danger",
                          confirmLabel: message("settings:deleteProfile"),
                        }))
                      )
                        return;
                      await run(async () => {
                        await api.DeleteAPI(profile.id);
                        await p.onRefresh();
                        setProfile({ ...emptyProfile });
                        setKey("");
                      });
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
              <div className="form-note">
                <KeyRound size={17} />
                <span>{t("settings:openaiCompatibleApi")}</span>
              </div>
              <label>
                {t("settings:profileName")}
                <input
                  value={profile.name}
                  placeholder={t("settings:customApi")}
                  onChange={(e) =>
                    setProfile({ ...profile, name: e.target.value })
                  }
                />
              </label>
              <label>
                Base URL
                <input
                  value={profile.baseUrl}
                  onChange={(e) =>
                    setProfile({ ...profile, baseUrl: e.target.value })
                  }
                  placeholder="https://api.example.com/v1"
                />
              </label>
              <label>
                API Key
                <input
                  type="password"
                  autoComplete="new-password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={
                    profile.secretRef
                      ? t("settings:keySavedLeaveEmptyToKeepIt")
                      : t(
                          "settings:skOptionalForLocalServicesWithoutAuthentication",
                        )
                  }
                />
              </label>
              <label>
                {t("settings:modelName")}
                <input
                  value={profile.model}
                  onChange={(e) =>
                    setProfile({ ...profile, model: e.target.value })
                  }
                  placeholder={t("settings:modelIdFromYourApiProvider")}
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={profile.toolsEnabled}
                  onChange={(e) =>
                    setProfile({ ...profile, toolsEnabled: e.target.checked })
                  }
                />
                {t("settings:enableToolCallsAiServerOperations")}
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={memoryOnly}
                  onChange={(e) => setMemoryOnly(e.target.checked)}
                />
                {t("settings:useKeyForThisSessionOnly")}
              </label>
              <p className="muted small">
                {t("settings:disableToolCallsForApisThatOnlySupport")}
              </p>
            </section>
          )}
          {tab === "automatic" && (
            <section className="settings-panel" aria-labelledby="settings-automatic-title">
              <div className="settings-panel-heading">
                <h3 id="settings-automatic-title">{t("ai:automatic")}</h3>
                <p>{t("settings:automaticDescription")}</p>
              </div>
              <div className="settings-inline-note">
                {t(
                  "settings:automaticModeProcessesTasksUsingCommandResultsEach",
                )}
              </div>
              <label>
                {t("settings:commandsPerRound")}
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={autoLimit}
                  onChange={(e) => setAutoLimit(Number(e.target.value))}
                />
              </label>
              <label>
                {t("settings:automaticExecutionScope")}
                <select
                  aria-label={t("settings:automaticExecutionScope")}
                  value={allowChanges ? "all" : "inspection"}
                  onChange={(e) => setAllowChanges(e.target.value === "all")}
                >
                  <option value="inspection">
                    {t("settings:inspectOnlyConfirmChanges")}
                  </option>
                  <option value="all">{t("ai:changesAllowed")}</option>
                </select>
              </label>
              <p className="muted small">
                {t("settings:default10CommandsPerRoundContinueAfterReaching")}
              </p>
              {allowChanges && (
                <p className="small danger-text">
                  {t(
                    "settings:allowsAutomaticConfigurationChangesInstallsDeletionsAndRestarts",
                  )}
                </p>
              )}
            </section>
          )}
          {tab === "general" && (
            <section className="settings-panel" aria-labelledby="settings-general-title">
              <div className="settings-panel-heading">
                <h3 id="settings-general-title">{t("settings:general")}</h3>
                <p>{t("settings:generalDescription")}</p>
              </div>
              <div className="settings-control-row">
                <div className="settings-control-copy">
                  <label htmlFor="settings-language">{t("settings:interfaceLanguage")}</label>
                  <p>{t("settings:languageDescription")}</p>
                </div>
                <select
                  id="settings-language"
                  className="settings-control-select"
                  value={p.language ?? "en"}
                  disabled={p.languageSaving}
                  onChange={(e) => {
                    setError("");
                    p.onLanguage?.(e.target.value as Language).catch((error) =>
                      setError(error),
                    );
                  }}
                >
                  {languages.map((language) => (
                    <option key={language.value} value={language.value}>
                      {language.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-control-row">
                <div className="settings-control-copy">
                  <label>{t("sessions:sessionBackupTitle")}</label>
                  <p>{t("sessions:sessionBackupDescription")}</p>
                </div>
                <div style={{ display:"flex", gap: 8 }}>
                  <button type="button" onClick={() => p.onExportSessionBackup?.()}>{t("sessions:exportSessionBackup")}</button>
                  <button type="button" onClick={() => p.onImportSessionBackup?.()}>{t("sessions:restoreSessionBackup")}</button>
                </div>
              </div>
              <div className="settings-theme-group">
                <h4>{t("settings:theme")}</h4>
                <p>{t("settings:themeDescription")}</p>
                <div className="settings-theme-options" role="group" aria-label={t("settings:theme")}>
                  {(["light", "dark"] as const).map((theme) => {
                    const Icon = theme === "light" ? Sun : Moon;
                    return (
                      <button
                        key={theme}
                        type="button"
                        className={`settings-theme-option ${p.theme === theme ? "selected" : ""}`}
                        aria-pressed={p.theme === theme}
                        onClick={() => p.onTheme(theme)}
                      >
                        <span className={`settings-theme-preview settings-theme-preview--${theme}`} aria-hidden="true">
                          <span className="settings-theme-preview-sidebar" />
                          <span className="settings-theme-preview-main">
                            <span />
                            <span />
                            <span />
                          </span>
                        </span>
                        <span className="settings-theme-option-label">
                          <Icon size={14} aria-hidden="true" />
                          {t(`settings:${theme}`)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>
          )}
          {tab === "terminal" && (
            <section className="settings-panel" aria-labelledby="settings-terminal-title">
              <div className="settings-panel-heading">
                <h3 id="settings-terminal-title">{t("settings:terminal")}</h3>
                <p>{t("settings:terminalDescription")}</p>
              </div>
              <div className="settings-terminal-group">
                <div className="settings-font-heading">
                  <label htmlFor="settings-font-size">{t("settings:fontSize")}</label>
                  <output htmlFor="settings-font-size">{p.fontSize} px</output>
                </div>
                <input
                  id="settings-font-size"
                  type="range"
                  min="11"
                  max="24"
                  value={p.fontSize}
                  onChange={(e) => p.onFont(Number(e.target.value))}
                />
              </div>
              <div className="settings-terminal-group">
                <label htmlFor="settings-quick-commands">{t("settings:quickCommandLayout")}</label>
                <select
                  id="settings-quick-commands"
                  value={p.quickCommandLayout}
                  onChange={(e) =>
                    p.onQuickCommandLayout(e.target.value as QuickCommandLayout)
                  }
                >
                  <option value="single">{t("settings:singleRowWithHorizontalScrollingDefault")}</option>
                  <option value="multi">{t("settings:multipleRowsWithWrapping")}</option>
                </select>
              </div>
              <div className="settings-terminal-group">
                <h4>{t("settings:terminalMouseActions")}</h4>
                <label className="settings-toggle-row">
                  <span className="settings-toggle-copy">
                    <strong>{t("settings:copySelectionAutomatically")}</strong>
                    <small>{t("settings:copyTextToTheClipboardAfterSelectingIt")}</small>
                  </span>
                  <input
                    className="settings-switch"
                    type="checkbox"
                    aria-label={t("settings:copySelectionAutomatically")}
                    checked={p.autoCopySelection}
                    onChange={(e) => p.onAutoCopySelection(e.target.checked)}
                  />
                </label>
                <label className="settings-toggle-row">
                  <span className="settings-toggle-copy">
                    <strong>{t("settings:rightClickToPaste")}</strong>
                    <small>{t("settings:rightClickInTheSshTerminalToPaste")}</small>
                  </span>
                  <input
                    className="settings-switch"
                    type="checkbox"
                    aria-label={t("settings:rightClickToPaste")}
                    checked={p.rightClickPaste}
                    onChange={(e) => p.onRightClickPaste(e.target.checked)}
                  />
                </label>
                {p.rightClickPaste && (
                  <label className="settings-toggle-row settings-toggle-row--nested">
                    <span className="settings-toggle-copy">
                      <strong>{t("settings:confirmMultilinePaste")}</strong>
                    </span>
                    <input
                      className="settings-switch"
                      type="checkbox"
                      aria-label={t("settings:confirmMultilinePaste")}
                      checked={p.confirmMultilinePaste}
                      onChange={(e) => p.onConfirmMultilinePaste(e.target.checked)}
                    />
                  </label>
                )}
              </div>
            </section>
          )}
          {!!error && (
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
        <footer>
          <button className="secondary" disabled={busy} onClick={p.onClose}>
            {t("common:close")}
          </button>
          <div>
            {tab === "api" && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  run(
                    () => api.TestAPI(apiRequest()),
                    message("settings:connectedModelRespondedSuccessfully"),
                  )
                }
              >
                {t("settings:testConnection")}
              </button>
            )}
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
                  if (session.authType === "key" && !session.privateKeyPath) {
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
            {tab === "api" && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  if (!profile.name.trim()) {
                    setError(message("settings:enterApiProfileName"));
                    setSuccess("");
                    return;
                  }
                  if (!profile.baseUrl.trim()) {
                    setError(message("settings:enterApiBaseUrl"));
                    setSuccess("");
                    return;
                  }
                  void run(async () => {
                    const saved = await api.SaveAPI(apiRequest());
                    setProfile(saved);
                    setKey("");
                    await p.onRefresh();
                  }, message("settings:profileSaved"));
                }}
              >
                {busy ? <LoaderCircle size={15} className="spin" /> : null}
                {t("settings:saveProfile")}
              </button>
            )}
            {tab === "automatic" && (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    if (
                      !Number.isInteger(autoLimit) ||
                      autoLimit < 1 ||
                      autoLimit > 100
                    )
                      throw new Error(
                        t("settings:commandLimitMustBeBetween1And100"),
                      );
                    await api.SavePreference(
                      "autoCommandLimit",
                      String(autoLimit),
                    );
                    await api.SavePreference(
                      "autoAllowChanges",
                      String(allowChanges),
                    );
                    await p.onRefresh();
                  }, message("settings:automaticSettingsSaved"))
                }
              >
                {t("settings:saveAutomaticSettings")}
              </button>
            )}
            {(tab === "general" || tab === "terminal") && (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api.SavePreference("fontSize", String(p.fontSize));
                    await api.SavePreference("theme", p.theme);
                    await api.SavePreference(
                      "quickCommandLayout",
                      p.quickCommandLayout,
                    );
                    await api.SavePreference(
                      "autoCopySelection",
                      String(p.autoCopySelection),
                    );
                    await api.SavePreference(
                      "rightClickPaste",
                      String(p.rightClickPaste),
                    );
                    await api.SavePreference(
                      "confirmMultilinePaste",
                      String(p.confirmMultilinePaste),
                    );
                  }, message("settings:settingsSaved"))
                }
              >
                {t("settings:saveSettings")}
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
