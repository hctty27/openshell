import { Sun, Moon } from "lucide-react";
import { t } from "../i18n";
import { languages, type Language } from "../i18n/languages";
import type { Theme } from "../types";

interface Props {
  language?: Language;
  languageSaving?: boolean;
  onLanguage?(language: Language): Promise<void>;
  onLanguageError(error: unknown): void;
  onExportSessionBackup?(): Promise<void>;
  onImportSessionBackup?(): Promise<void>;
  theme: Theme;
  onTheme(theme: Theme): void;
}

export default function GeneralSettingsPanel(p: Props) {
  return (
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
                    p.onLanguageError("");
                    p.onLanguage?.(e.target.value as Language).catch((error) =>
                      p.onLanguageError(error),
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
  );
}
