import { t } from "../i18n";

interface Props {
  keepAliveSeconds: number;
  setKeepAliveSeconds(value: number): void;
  autoReconnect: boolean;
  setAutoReconnect(value: boolean): void;
  maxReconnectAttempts: number;
  setMaxReconnectAttempts(value: number): void;
  showDisconnectReason: boolean;
  setShowDisconnectReason(value: boolean): void;
  disconnectBehavior: string;
  setDisconnectBehavior(value: string): void;
  localShell: string;
  setLocalShell(value: string): void;
  preserveTerminalHistory: boolean;
  setPreserveTerminalHistory(value: boolean): void;
  confirmActiveDisconnect: boolean;
  setConfirmActiveDisconnect(value: boolean): void;
}

export default function ConnectionSettingsPanel({
  keepAliveSeconds, setKeepAliveSeconds, autoReconnect, setAutoReconnect,
  maxReconnectAttempts, setMaxReconnectAttempts, showDisconnectReason, setShowDisconnectReason,
  disconnectBehavior, setDisconnectBehavior, localShell, setLocalShell,
  preserveTerminalHistory, setPreserveTerminalHistory, confirmActiveDisconnect,
  setConfirmActiveDisconnect,
}: Props) {
  return (
            <section className="settings-panel" aria-labelledby="settings-connection-title">
              <div className="settings-panel-heading">
                <h3 id="settings-connection-title">{t("settings:connection")}</h3>
                <p>{t("settings:connectionDescription")}</p>
              </div>
              <div className="settings-terminal-group">
                <label htmlFor="settings-keepalive">{t("settings:keepAliveInterval")}</label>
                <select id="settings-keepalive" value={keepAliveSeconds} onChange={e => setKeepAliveSeconds(Number(e.target.value))}>
                  <option value={0}>{t("settings:disabled")}</option>
                  <option value={15}>15 {t("settings:seconds")}</option>
                  <option value={30}>30 {t("settings:seconds")}</option>
                  <option value={60}>60 {t("settings:seconds")}</option>
                </select>
              </div>
              <div className="settings-terminal-group">
                <label className="settings-toggle-row">
                  <span className="settings-toggle-copy">
                    <strong>{t("settings:autoReconnect")}</strong>
                    <small>{t("settings:autoReconnectDescription")}</small>
                  </span>
                  <input className="settings-switch" type="checkbox" checked={autoReconnect}
                    onChange={e => setAutoReconnect(e.target.checked)} />
                </label>
              </div>
              <div className="settings-terminal-group">
                <label htmlFor="settings-retries">{t("settings:maxReconnectAttempts")}</label>
                <select id="settings-retries" disabled={!autoReconnect} value={maxReconnectAttempts}
                  onChange={e => setMaxReconnectAttempts(Number(e.target.value))}>
                  <option value={5}>5</option><option value={10}>10</option><option value={20}>20</option>
                  <option value={0}>{t("settings:continuousRetry")}</option>
                </select>
              </div>
              <div className="settings-terminal-group">
                <label className="settings-toggle-row">
                  <span className="settings-toggle-copy"><strong>{t("settings:showDisconnectReason")}</strong></span>
                  <input className="settings-switch" type="checkbox" checked={showDisconnectReason}
                    onChange={e => setShowDisconnectReason(e.target.checked)} />
                </label>
              </div>
              <div className="settings-terminal-group">
                <label htmlFor="settings-disconnect-behavior">{t("settings:disconnectBehavior")}</label>
                <select id="settings-disconnect-behavior" value={disconnectBehavior}
                  onChange={e => setDisconnectBehavior(e.target.value as import("../types").DisconnectBehavior)}>
                  <option value="local">{t("settings:revertToLocalShell")}</option>
                  <option value="retain">{t("settings:retainDisconnectedTerminal")}</option>
                  <option value="close">{t("settings:closeDisconnectedTab")}</option>
                </select>
              </div>
              {disconnectBehavior === "local" && (
                <div className="settings-terminal-group">
                  <label htmlFor="settings-local-shell">{t("settings:defaultLocalShell")}</label>
                  <select id="settings-local-shell" value={localShell}
                    onChange={e => setLocalShell(e.target.value as import("../types").LocalShell)}>
                    <option value="powershell">Windows PowerShell</option>
                    <option value="pwsh">PowerShell 7</option>
                    <option value="cmd">CMD</option>
                    <option value="wsl">WSL</option>
                  </select>
                </div>
              )}
              <div className="settings-terminal-group">
                <label className="settings-toggle-row">
                  <span className="settings-toggle-copy"><strong>{t("settings:preserveTerminalHistory")}</strong></span>
                  <input className="settings-switch" type="checkbox" checked={preserveTerminalHistory}
                    onChange={e => setPreserveTerminalHistory(e.target.checked)} />
                </label>
              </div>
              <div className="settings-terminal-group">
                <label className="settings-toggle-row">
                  <span className="settings-toggle-copy"><strong>{t("settings:confirmActiveDisconnect")}</strong></span>
                  <input className="settings-switch" type="checkbox" checked={confirmActiveDisconnect}
                    onChange={e => setConfirmActiveDisconnect(e.target.checked)} />
                </label>
              </div>
            </section>
  );
}
