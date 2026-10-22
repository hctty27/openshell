import { useState } from "react";
import { FileArchive, X, AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import { errorText } from "../bridge";
import { importIssueText } from "../i18n/errors";
import type { XshellImportPreview } from "../types";

interface Props {
  preview: XshellImportPreview;
  onClose(): void;
  onImport(ids: string[], conflict: "skip" | "rename"): Promise<void>;
}

export default function XshellImportDialog({ preview, onClose, onImport }: Props) {
  useTranslation();
  const [selected, setSelected] = useState<string[]>(() => preview.entries.map((entry) => entry.id));
  const [conflict, setConflict] = useState<"skip" | "rename">("skip");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>("");
  const native = preview.source === "openshell";
  const title = t(native ? "sessions:importBackupTitle" : "sessions:importXshellTitle");
  const all = selected.length === preview.entries.length && selected.length > 0;
  const toggle = (id: string) => setSelected((prev) =>
    prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
  );

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="xshell-import-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header className="xshell-import-header">
          <div><h2><FileArchive size={19} /> {title}</h2>
            <p>{t(native ? "sessions:importBackupDescription" : "sessions:importXshellDescription")}</p>
          </div>
          <button type="button" title={t("common:close")} disabled={busy} onClick={onClose}><X size={18} /></button>
        </header>
        <div className="xshell-import-content">
          <label className="xshell-import-select-all">
            <input type="checkbox" checked={all} onChange={(e) =>
              setSelected(e.target.checked ? preview.entries.map((entry) => entry.id) : [])
            } />
            <span>{t("sessions:selectAllImport")} ({selected.length}/{preview.entries.length})</span>
          </label>
          <div className="xshell-import-list">
            {preview.entries.map((entry) => (
              <label key={entry.id} className="xshell-import-entry">
                <input type="checkbox" checked={selected.includes(entry.id)} disabled={busy} onChange={() => toggle(entry.id)} />
                <div>
                  <strong>{entry.session.name}</strong>
                  <small>{entry.folder ? entry.folder + " / " : ""}{entry.session.username}@{entry.session.host}:{entry.session.port}</small>
                  {entry.warning && <small className="xshell-import-warning">{entry.warning.includes("key")
                    ? t("sessions:xshellKeyWarning") : t("sessions:xshellPasswordWarning")}</small>}
                </div>
              </label>
            ))}
          </div>
          {preview.skipped.length > 0 && (
            <details className="xshell-import-skipped">
              <summary><AlertTriangle size={14} /> {t("sessions:xshellSkipped")} ({preview.skipped.length})</summary>
              <ul>{preview.skipped.map((entry, index) => <li key={index}>{importIssueText(entry)}</li>)}</ul>
            </details>
          )}
          <div className="xshell-import-conflict">
            <label htmlFor="xshell-conflict">{t("sessions:duplicateSessions")}</label>
            <select id="xshell-conflict" disabled={busy} value={conflict} onChange={(e) => setConflict(e.target.value as "skip" | "rename")}>
              <option value="skip">{t("sessions:skipDuplicates")}</option>
              <option value="rename">{t("sessions:renameDuplicates")}</option>
            </select>
          </div>
          {!!error && <p role="alert" className="danger-text">{errorText(error)}</p>}
        </div>
        <footer className="xshell-import-footer">
          <button type="button" disabled={busy} onClick={onClose}>{t("common:cancel")}</button>
          <button type="button" className="primary" disabled={busy || selected.length === 0}
            onClick={async () => {
              setBusy(true); setError("");
              try { await onImport(selected, conflict); } catch (e) { setError(e); }
              finally { setBusy(false); }
            }}>
            {busy ? t("sessions:importingXshell") : t("sessions:importSelectedXshell")}
          </button>
        </footer>
      </section>
    </div>
  );
}
