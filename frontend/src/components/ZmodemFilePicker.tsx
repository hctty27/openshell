import { useEffect, useRef, useState } from "react";
import { ArrowUp, File, Folder, HardDrive, Home, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, errorText, listen } from "../bridge";
import { t } from "../i18n";
import type { Ref, SFTPEntry } from "../types";

type Direction = "upload" | "download";
interface PickerRequest { ref: Ref; id: number; direction: Direction }
interface Places { home: string; roots: string[] }
interface Props { activeRef?: Ref; onNotice(error: unknown): void }

const refKey = (ref: Ref) => `${ref.tabId}:${ref.sessionId}:${ref.generation}`;
const parentPath = (directory: string) => {
  const trimmed = directory.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return index < 0 ? directory : trimmed.slice(0, index + 1) || directory;
};
const niceSize = (size: number) =>
  size < 1024 ? `${size} B` : `${(size / 1048576).toFixed(1)} MB`;

export default function ZmodemFilePicker({ activeRef, onNotice }: Props) {
  useTranslation();
  const [requests, setRequests] = useState<Record<string, PickerRequest>>({});
  const activeRequest = activeRef ? requests[refKey(activeRef)] : undefined;
  const requestKey = activeRequest ? `${refKey(activeRequest.ref)}:${activeRequest.id}` : "";
  const [directory, setDirectory] = useState("");
  const [draft, setDraft] = useState("");
  const [places, setPlaces] = useState<Places | null>(null);
  const [entries, setEntries] = useState<SFTPEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const offPick = listen("ssh:zmodem-pick", (request: PickerRequest) => {
      if (!request?.ref || !["upload", "download"].includes(request.direction)) return;
      setRequests(previous => ({ ...previous, [refKey(request.ref)]: request }));
    });
    const offEnded = listen("ssh:zmodem-pick-ended", (event: {ref: Ref; id: number}) => {
      if (!event?.ref) return;
      setRequests(previous => {
        const key = refKey(event.ref);
        if (previous[key]?.id !== event.id) return previous;
        const next = { ...previous };
        delete next[key];
        return next;
      });
    });
    const offDisconnected = listen("ssh:disconnected", (ref: Ref) => {
      if (!ref) return;
      setRequests(previous => {
        const next = { ...previous };
        delete next[refKey(ref)];
        return next;
      });
    });
    const offError = listen("ssh:zmodem-pick-error", (event: {error: string}) => {
      if (event?.error) onNotice(event.error);
    });
    return () => { offPick(); offEnded(); offDisconnected(); offError(); };
  }, [onNotice]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!activeRequest || !dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    };
  }, [requestKey]);

  useEffect(() => {
    if (!activeRequest) return;
    let current = true;
    setDirectory("");
    setDraft("");
    setPlaces(null);
    setEntries([]);
    setSelected([]);
    setBusy(false);
    setError("");
    void api.ZmodemLocalPlaces().then((result: Places) => {
      if (!current) return;
      setPlaces(result);
      setDirectory(result.home);
      setDraft(result.home);
    }).catch(err => { if (current) setError(errorText(err)); });
    return () => { current = false; };
  }, [requestKey]);

  useEffect(() => {
    if (!activeRequest || !directory) return;
    let current = true;
    setLoading(true);
    setError("");
    setSelected([]);
    setDraft(directory);
    void api.SFTPList(activeRequest.ref, "local", directory).then((result: SFTPEntry[]) => {
      if (current) setEntries(result);
    }).catch(err => { if (current) { setEntries([]); setError(errorText(err)); } })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [requestKey, directory, reload]);

  if (!activeRequest) return null;
  const request = activeRequest;
  const visible = entries.filter(item => showHidden || !item.name.startsWith("."));
  const goTo = (path: string) => {
    if (!path || busy) return;
    setDirectory(path);
    setDraft(path);
    setReload(value => value + 1);
  };
  const submit = async (paths: string[]) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.SubmitZmodemSelection(request.ref, request.id, paths);
      setRequests(previous => {
        const next = { ...previous };
        if (next[refKey(request.ref)]?.id === request.id) delete next[refKey(request.ref)];
        return next;
      });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  const download = request.direction === "download";
  return (
    <dialog ref={dialogRef} className="zmodem-picker-dialog"
      aria-label={t(download ? "sftp:zmodemPickDownload" : "sftp:zmodemPickUpload")}
      onCancel={event => { event.preventDefault(); void submit([]); }}>
      <header className="zmodem-picker-header">
        <Folder size={18} aria-hidden="true" />
        <h2>{t(download ? "sftp:zmodemPickDownload" : "sftp:zmodemPickUpload")}</h2>
        <button type="button" aria-label={t("sftp:zmodemPickClose")} disabled={busy}
          onClick={() => void submit([])}><X size={17} /></button>
      </header>
      <div className="zmodem-picker-toolbar">
        <button type="button" aria-label={t("sftp:up")} onClick={() => goTo(parentPath(directory))} disabled={busy || !directory}>
          <ArrowUp size={16} />
        </button>
        <button type="button" aria-label={t("sftp:zmodemPickHome")} onClick={() => places && goTo(places.home)}
          disabled={busy || !places}><Home size={16} /></button>
        <form onSubmit={event => { event.preventDefault(); goTo(draft); }}>
          <input aria-label={t("sftp:path")} value={draft} onChange={event => setDraft(event.target.value)}
            spellCheck={false} disabled={busy} />
        </form>
        <button type="button" aria-label={t("sftp:refresh")} onClick={() => setReload(n => n + 1)} disabled={busy}>
          <RefreshCw size={16} />
        </button>
      </div>
      <nav className="zmodem-picker-roots" aria-label={t("sftp:zmodemPickDrives")}>
        {places?.roots.map(root => (
          <button type="button" key={root} disabled={busy} onClick={() => goTo(root)}>
            <HardDrive size={14} /> {root}
          </button>
        ))}
      </nav>
      <div className="zmodem-picker-list" role="list" aria-label={t("sftp:selectFiles")}>
        {loading ? <p className="zmodem-picker-placeholder">{t("sftp:loading")}</p> :
          error ? <p className="zmodem-picker-placeholder zmodem-picker-error" role="alert">{error}</p> :
          visible.length === 0 ? <p className="zmodem-picker-placeholder">{t("sftp:emptyFolder")}</p> :
          visible.map(entry => (
            <button type="button" key={entry.path} role="listitem"
              className={`zmodem-picker-entry ${selected.includes(entry.path) ? "selected" : ""}`}
              disabled={busy || entry.isSymlink}
              onClick={() => {
                if (entry.isDir || download) return;
                setSelected(previous => previous.includes(entry.path)
                  ? previous.filter(file => file !== entry.path)
                  : [...previous, entry.path]);
              }}
              onDoubleClick={() => {
                if (entry.isDir) goTo(entry.path);
                else if (!download) setSelected(previous => previous.includes(entry.path) ? previous : [...previous, entry.path]);
              }}>
              {entry.isDir ? <Folder size={16} /> : <File size={16} />}
              <span title={entry.path}>{entry.name}</span>
              <small>{entry.isDir ? t("sftp:zmodemPickFolder") : niceSize(entry.size)}</small>
              {!download && !entry.isDir && <input type="checkbox" tabIndex={-1} readOnly
                checked={selected.includes(entry.path)} aria-label={entry.name} />}
            </button>
          ))}
      </div>
      <footer className="zmodem-picker-footer">
        <label>
          <input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} />
          {t("sftp:showHidden")}
        </label>
        <span className="zmodem-picker-count">
          {download ? t("sftp:zmodemPickTarget") : t("sftp:zmodemPickSelected", { count: selected.length })}
        </span>
        <button type="button" onClick={() => void submit([])} disabled={busy}>
          {t("sftp:zmodemPickCancel")}
        </button>
        <button className="zmodem-picker-primary" type="button" disabled={busy || !directory || (!download && selected.length === 0)}
          onClick={() => void submit(download ? [directory] : selected)}>
          {t(download ? "sftp:zmodemPickSaveHere" : "sftp:zmodemPickSend")}
        </button>
      </footer>
    </dialog>
  );
}
