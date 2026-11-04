import { Sun, Moon } from "lucide-react";
import { t } from "../i18n";
import { resolveTerminalTheme } from "../terminalThemes";
import type { Theme, TerminalTheme } from "../types";

interface Props {
  theme: Theme;
  onTheme(theme: Theme): void;
  terminalTheme: TerminalTheme;
  onTerminalTheme(theme: TerminalTheme): void;
  fontSize: number;
  onFont(value: number): void;
}

export default function AppearanceSettingsPanel(p: Props) {
  const terminalPreview = resolveTerminalTheme(p.theme, p.terminalTheme);
  return (
    <section className="settings-panel" aria-labelledby="settings-appearance-title">
      <div className="settings-panel-heading">
        <h3 id="settings-appearance-title">{t("settings:appearance")}</h3>
        <p>{t("settings:appearanceDescription")}</p>
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
      <div className="settings-appearance-terminal">
        <h4>{t("settings:terminal")}</h4>
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

      </div>
    </section>
  );
}
