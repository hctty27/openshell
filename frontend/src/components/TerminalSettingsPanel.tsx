import { t } from "../i18n";
import type { ZmodemTransferMode } from "../types";

interface Props {
  logHighlights: boolean;
  onLogHighlights(enabled: boolean): void;
  zmodemTransferMode: ZmodemTransferMode;
  onZmodemTransferMode(mode: ZmodemTransferMode): void;
  autoCopySelection: boolean;
  onAutoCopySelection(enabled: boolean): void;
  rightClickPaste: boolean;
  onRightClickPaste(enabled: boolean): void;
  confirmMultilinePaste: boolean;
  onConfirmMultilinePaste(enabled: boolean): void;
}

export default function TerminalSettingsPanel(p: Props) {
  return (
            <section className="settings-panel" aria-labelledby="settings-terminal-title">
              <div className="settings-panel-heading">
                <h3 id="settings-terminal-title">{t("settings:terminal")}</h3>
                <p>{t("settings:terminalDescription")}</p>
              </div>
              <div className="settings-terminal-group">
                <label className="settings-toggle-row">
                  <span className="settings-toggle-copy">
                    <strong>{t("settings:logHighlights")}</strong>
                    <small>{t("settings:logHighlightsDescription")}</small>
                  </span>
                  <input className="settings-switch" type="checkbox"
                    aria-label={t("settings:logHighlights")}
                    checked={p.logHighlights}
                    onChange={(e) => p.onLogHighlights(e.target.checked)} />
                </label>
              </div>
              <div className="settings-control-row">
                <div className="settings-control-copy">
                  <label htmlFor="settings-zmodem-transfer-mode">{t("settings:zmodemTransferMode")}</label>
                  <p>{t("settings:zmodemTransferModeDescription")}</p>
                </div>
                <select
                  id="settings-zmodem-transfer-mode"
                  className="settings-control-select"
                  value={p.zmodemTransferMode}
                  onChange={(event) => p.onZmodemTransferMode(event.target.value as ZmodemTransferMode)}
                >
                  <option value="native">{t("settings:zmodemNativeFirst")}</option>
                  <option value="legacy">{t("settings:zmodemLegacy")}</option>
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
  );
}
