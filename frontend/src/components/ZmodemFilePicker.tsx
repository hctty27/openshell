import { useEffect, useRef, useState } from "react";
import { ArrowUp, File, Folder, HardDrive, Home, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, errorText, listen } from "../bridge";
import { t } from "../i18n";
import type { Ref, SFTPEntry } from "../types";
import { requestTerminalFocus } from "../features/terminalFocus";

type Direction = "upload" | "upload-overwrite" | "download";
interface PickerRequest { ref: Ref; id: number; selectionId: number; direction: Direction; remotePath?: string; passive?: boolean }
interface Places { home: string; roots: string[] }
interface Props {
  activeRef?: Ref;
  onNotice(error: unknown): void;
  onClosed?(ref: Ref): void;
}

const refKey = (ref: Ref) => `${ref.tabId}:${ref.sessionId}:${ref.generation}`;
const parentPath = (directory: string) => {
  const trimmed = directory.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return index < 0 ? directory : trimmed.slice(0, index + 1) || directory;
};
const niceSize = (size: number) =>
  size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` :
    size < 1073741824 ? `${(size / 1048576).toFixed(1)} MB` : `${(size / 1073741824).toFixed(2)} GB`;

export default function ZmodemFilePicker({ activeRef, onNotice, onClosed }: Props) {
  useTranslation();
  const [requests, setRequests] = useState<Record<string, PickerRequest>>({});
  const activeRequest = activeRef ? requests[refKey(activeRef)] : undefined;
  const requestKey = activeRequest ? `${refKey(activeRequest.ref)}:${activeRequest.id}` : "";
  const [directory, setDirectory] = useState("");
  const [draft, setDraft] = useState("");
  const [places, setPlaces] = useState<Places | null>(null);
  const [entries, setEntries] = useState<SFTPEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submittingKey = useRef("");
  const navigatedDirectory = useRef("");
  const nextNativeRequestID = useRef(0);
  const currentRequestKey = useRef(requestKey);
  const onClosedRef = useRef(onClosed);
  currentRequestKey.current = requestKey;
  onClosedRef.current = onClosed;

  useEffect(() => {
    const offNativeIntent = listen("ssh:native-zmodem-auto-intent", (event: {
      ref?: Ref;
      direction?: Direction;
      remotePath?: string;
      selectionId?: number;
      passive?: boolean;
    }) => {
      if (!event?.ref || !Number.isSafeInteger(event.selectionId) || (event.selectionId ?? 0) <= 0 ||
        (event.direction !== "upload" && event.direction !== "upload-overwrite" && event.direction !== "download")) return;
      const request: PickerRequest = {
        ref: event.ref,
        id: -(++nextNativeRequestID.current),
        selectionId: event.selectionId!,
        passive: event.passive === true,
        direction: event.direction,
        remotePath: event.remotePath ?? "",
      };
      setRequests(previous => ({ ...previous, [refKey(request.ref)]: request }));
    });
    const offDisconnected = listen("ssh:disconnected", (ref: Ref) => {
      if (!ref) return;
      setRequests(previous => {
        const next = { ...previous };
        delete next[refKey(ref)];
        return next;
      });
    });
    const offError = listen("ssh:native-zmodem-command-error", (event: { error?: string }) => {
      if (event?.error) onNotice(event.error);
    });
    const offUnsupported = listen("ssh:native-zmodem-unsupported", (event: { ref?: Ref; error?: string }) => {
      if (event?.ref) setRequests(previous => {
        const key = refKey(event.ref!);
        if (!previous[key]?.passive) return previous;
        const next = { ...previous };
        delete next[key];
        return next;
      });
      if (event?.error) onNotice(event.error);
    });
    return () => { offNativeIntent(); offDisconnected(); offError(); offUnsupported(); };
  }, [onNotice]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!activeRequest || !dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    const closingRef = activeRequest.ref;
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      onClosedRef.current?.(closingRef);
      // Return keyboard focus to the terminal once the modal is gone.
      setTimeout(requestTerminalFocus, 0);
    };
  }, [requestKey]);

  useEffect(() => {
    if (!activeRequest) return;
    let current = true;
    navigatedDirectory.current = "";
    setDirectory("");
    setDraft("");
    setPlaces(null);
    setEntries([]);
    setSelected([]);
    setOverwriteConfirmed(false);
    submittingKey.current = "";
    setBusy(false);
    setError("");
    void api.ZmodemLocalPlaces().then(async (result: Places) => {
      let initialDirectory = result.home;
      try {
        initialDirectory = await api.GetTransferLocalDir(activeRequest.ref.sessionId);
      } catch { /* use the local home directory if the preference cannot be read */ }
      if (!current) return;
      setPlaces(result);
      setDirectory(initialDirectory);
      setDraft(initialDirectory);
    }).catch(err => { if (current) setError(errorText(err)); });
    return () => { current = false; };
  }, [requestKey]);

  useEffect(() => {
    if (!activeRequest || !directory) return;
    let current = true;
    setLoading(true);
    setError("");
    setSelected([]);
    setOverwriteConfirmed(false);
    setDraft(directory);
    void api.SFTPList(activeRequest.ref, "local", directory).then((result: SFTPEntry[]) => {
      if (current) {
        setEntries(result);
        if (navigatedDirectory.current === directory) {
          navigatedDirectory.current = "";
          void api.SaveTransferLocalDir(activeRequest.ref.sessionId, directory).catch(onNotice);
        }
      }
    }).catch(err => { if (current) { setEntries([]); setError(errorText(err)); } })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [requestKey, directory, reload]);

  if (!activeRequest) return null;
  const request = activeRequest;
  const visible = entries.filter(item => showHidden || !item.name.startsWith("."));
  const goTo = (path: string) => {
    if (!path || busy) return;
    navigatedDirectory.current = path;
    setDirectory(path);
    setDraft(path);
    setReload(value => value + 1);
  };
  const closeRequest = () => {
    if (currentRequestKey.current !== requestKey) return;
    const dialog = dialogRef.current;
    if (dialog?.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
    setRequests(previous => {
      const key = refKey(request.ref);
      if (previous[key]?.id !== request.id) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  };
  const submit = (paths: string[]) => {
    if (busy || submittingKey.current === requestKey ||
      currentRequestKey.current !== requestKey) return;
    submittingKey.current = requestKey;
    setError("");
    try {
      let pending: Promise<void> | undefined;
      if (paths.length > 0) {
        const download = request.direction === "download";
        if (!download && paths.length !== 1) throw new Error("ZMODEM 每次只能上传一个文件");
        if ((request.direction === "upload-overwrite" || (request.passive && request.direction === "upload")) && !overwriteConfirmed) {
          throw new Error(t("sftp:zmodemOverwriteConfirm"));
        }
        const remotePath = request.remotePath ?? "";
        if (download && (!request.passive && !remotePath || /[\r\n]/.test(remotePath))) {
          throw new Error("ZMODEM 每次只能下载一个远程文件");
        }
        pending = request.passive
          ? api.StartNativeZmodemPassiveTransfer(
              request.ref, request.selectionId,
              request.direction === "download" ? "download" : "upload",
              download ? directory : paths[0],
            )
          : api.StartNativeZmodemInteractiveTransfer(
              request.ref, request.direction,
              download ? directory : paths[0], download ? remotePath : "",
            );
        void api.SaveTransferLocalDir(request.ref.sessionId, directory).catch(onNotice);
      } else {
        // Closing the picker does not start a protocol task. Explicitly
        // release its backend terminal reservation before accepting typing.
        pending = api.CancelNativeZmodemSelection(request.ref, request.selectionId);
      }
      closeRequest();
      if (pending) void pending.catch(err => {
        // If admission failed before the native task took ownership, the
        // file picker no longer exists to release its selection lease.
        // The transfer may already have taken ownership, making release
        // correctly return "not active". Preserve the original error only.
        void api.CancelNativeZmodemSelection(request.ref, request.selectionId).catch(() => {});
        const message = errorText(err);
        if (message.includes("终端已安全恢复") && message.includes("context canceled")) return;
        onNotice(err);
      });
    } catch (err) {
      setError(errorText(err));
      submittingKey.current = "";
    }
  };
  const download = request.direction === "download";
  // A remote-origin rz may have been started with -y, which the first
  // ZRINIT frame cannot reveal. Require explicit overwrite acknowledgement.
  const overwrite = request.direction === "upload-overwrite" || (request.passive && request.direction === "upload");
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
                if (download || entry.isDir) return;
                setOverwriteConfirmed(false);
                setSelected(previous => previous.includes(entry.path) ? [] : [entry.path]);
              }}
              onDoubleClick={() => {
                if (entry.isDir) goTo(entry.path);
                else if (!download) { setOverwriteConfirmed(false); setSelected([entry.path]); }
              }}>
              {entry.isDir ? <Folder size={16} /> : <File size={16} />}
              <span title={entry.path}>{entry.name}</span>
              <small>{entry.isDir ? t("sftp:zmodemPickFolder") : niceSize(entry.size)}</small>
              {!download && !entry.isDir && <input
                type="radio" tabIndex={-1} readOnly
                checked={selected.includes(entry.path)} aria-label={entry.name} />}
            </button>
          ))}
      </div>
      {overwrite && selected.length > 0 && (
        <div className="zmodem-picker-overwrite">
          <p role="alert">{t("sftp:zmodemOverwriteWarning")}</p>
          <label>
            <input type="checkbox" checked={overwriteConfirmed}
              onChange={event => setOverwriteConfirmed(event.target.checked)} />
            {t("sftp:zmodemOverwriteConfirm")}
          </label>
        </div>
      )}
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
        <button className="zmodem-picker-primary" type="button" disabled={busy || !directory || (!download && selected.length === 0) ||
            (overwrite && !overwriteConfirmed)}
          onClick={() => void submit(download ? [directory] : selected)}>
          {t(download ? "sftp:zmodemPickSaveHere" :
            overwrite ? "sftp:zmodemOverwriteSend" : "sftp:zmodemPickSend")}
        </button>
      </footer>
    </dialog>
  );
}
