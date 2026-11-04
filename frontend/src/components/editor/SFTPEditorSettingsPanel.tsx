import { useState } from "react";
import { t } from "../../i18n";
import {
  readSFTPEditorPreferences,
  writeSFTPEditorPreferences,
  type IndentMode,
  type IndentSize,
  type SFTPEditorPreferences,
} from "./sftpEditorPreferences";

export default function SFTPEditorSettingsPanel() {
  const [preferences, setPreferences] = useState(readSFTPEditorPreferences);
  const update = (patch: Partial<SFTPEditorPreferences>) => {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    writeSFTPEditorPreferences(next);
  };
  return (
    <section className="settings-panel" aria-labelledby="settings-sftp-editor">
      <div className="settings-panel-heading">
        <h3 id="settings-sftp-editor">{t("sftp:editorSettings")}</h3>
        <p>{t("sftp:editorSettingsDescription")}</p>
      </div>
      <div className="settings-control-row">
        <div className="settings-control-copy"><label htmlFor="sftp-editor-indent-mode">{t("sftp:editorIndent")}</label></div>
        <select id="sftp-editor-indent-mode" className="settings-control-select" value={preferences.indentMode} onChange={event => update({ indentMode: event.target.value as IndentMode })}>
          <option value="auto">{t("sftp:editorAutoIndent")}</option>
          <option value="spaces">{t("sftp:editorSpaces")}</option>
          <option value="tabs">Tab</option>
        </select>
      </div>
      <div className="settings-control-row">
        <div className="settings-control-copy"><label htmlFor="sftp-editor-indent-size">{t("sftp:editorIndentWidth")}</label></div>
        <select id="sftp-editor-indent-size" className="settings-control-select" value={preferences.indentSize} onChange={event => update({ indentSize: Number(event.target.value) as IndentSize })}>
          {[2, 4, 8].map(size => <option key={size} value={size}>{size}</option>)}
        </select>
      </div>
      {([
        ["lineNumbers", "editorLineNumbers"],
        ["syntaxHighlight", "editorSyntaxHighlight"],
        ["wordWrap", "editorWordWrap"],
      ] as const).map(([name, label]) => (
        <div className="settings-control-row" key={name}>
          <label className="checkbox">
            <input type="checkbox" checked={preferences[name]} onChange={event => update({ [name]: event.target.checked })} />
            {t("sftp:" + label)}
          </label>
        </div>
      ))}
    </section>
  );
}
