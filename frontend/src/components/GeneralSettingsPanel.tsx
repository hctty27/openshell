import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { api } from "../bridge";
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
  const [transferDirectory, setTransferDirectory] = useState("");
  const [savingTransferDirectory, setSavingTransferDirectory] = useState(false);
  useEffect(() => {
    let active = true;
    void api.GetTransferDefaultLocalDir()
      .then(directory => { if (active) setTransferDirectory(directory); })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  const updateTransferDirectory = async (directory: string) => {
    setSavingTransferDirectory(true);
    p.onLanguageError("");
    try {
      await api.SetTransferDefaultLocalDir(directory);
      setTransferDirectory(await api.GetTransferDefaultLocalDir());
    } catch (error) {
      p.onLanguageError(error);
    } finally {
      setSavingTransferDirectory(false);
    }
  };
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
              <div className="settings-control-row">
                <div className="settings-control-copy">
                  <label htmlFor="settings-transfer-directory">{t("settings:defaultTransferDirectory")}</label>
                  <p>{t("settings:defaultTransferDirectoryDescription")}</p>
                </div>
                <div className="settings-directory-picker">
                  <input
                    id="settings-transfer-directory"
                    value={transferDirectory}
                    readOnly
                    title={transferDirectory}
                  />
                  <button
                    type="button"
                    aria-label={t("settings:chooseTransferDirectory")}
                    disabled={savingTransferDirectory}
                    onClick={() => void api.SFTPChooseDirectory()
                      .then(directory => { if (directory) return updateTransferDirectory(directory); })
                      .catch(p.onLanguageError)}
                  >
                    <FolderOpen size={15} />
                  </button>
                  <button
                    type="button"
                    disabled={savingTransferDirectory}
                    onClick={() => void updateTransferDirectory("")}
                  >
                    {t("settings:resetTransferDirectory")}
                  </button>
                </div>
              </div>

            </section>
  );
}
