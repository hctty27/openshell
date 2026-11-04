import { t } from "../i18n";
import { languages, type Language } from "../i18n/languages";

interface Props {
  language?: Language;
  languageSaving?: boolean;
  onLanguage?(language: Language): Promise<void>;
  onLanguageError(error: unknown): void;
  onExportSessionBackup?(): Promise<void>;
  onImportSessionBackup?(): Promise<void>;
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

            </section>
  );
}
