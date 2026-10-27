import { t } from "../i18n";
import { resolveTerminalTheme } from "../terminalThemes";
import type { Theme, TerminalTheme, QuickCommandLayout } from "../types";

interface Props {
  theme: Theme;
  terminalTheme: TerminalTheme;
  onTerminalTheme(theme: TerminalTheme): void;
  fontSize: number;
  onFont(value: number): void;
  quickCommandLayout: QuickCommandLayout;
  onQuickCommandLayout(layout: QuickCommandLayout): void;
  logHighlights: boolean;
  onLogHighlights(enabled: boolean): void;
  autoCopySelection: boolean;
  onAutoCopySelection(enabled: boolean): void;
  rightClickPaste: boolean;
  onRightClickPaste(enabled: boolean): void;
  confirmMultilinePaste: boolean;
  onConfirmMultilinePaste(enabled: boolean): void;
}

export default function TerminalSettingsPanel(p: Props) {
  const terminalPreview = resolveTerminalTheme(p.theme, p.terminalTheme);
  return (
            <section className="settings-panel" aria-labelledby="settings-terminal-title">
              <div className="settings-panel-heading">
                <h3 id="settings-terminal-title">{t("settings:terminal")}</h3>
                <p>{t("settings:terminalDescription")}</p>
              </div>
              <div className="settings-terminal-group">
                <label htmlFor="settings-terminal-theme">{t("settings:terminalColorScheme")}</label>
                <select
                  id="settings-terminal-theme"
                  value={p.terminalTheme}
                  onChange={(e) => p.onTerminalTheme(e.target.value as TerminalTheme)}
                >
                  <option value="follow">{t("settings:terminalThemeFollow")}</option>
                  <option value="classic">{t("settings:terminalThemeClassic")}</option>
                  <option value="dark">{t("settings:terminalThemeDark")}</option>
                  <option value="light">{t("settings:terminalThemeLight")}</option>
                </select>
                <div className="terminal-palette-preview"
                  aria-label={t("settings:terminalPalettePreview")}
                  style={{ backgroundColor: terminalPreview.background, color: terminalPreview.foreground }}>
                  <span style={{ color: terminalPreview.green }}>root@server</span>:~# ls -la{"\n"}
                  <span style={{ color: terminalPreview.blue }}>Documents  Downloads</span>
                </div>
                <p className="muted small">{t("settings:terminalThemeDescription")}</p>
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
