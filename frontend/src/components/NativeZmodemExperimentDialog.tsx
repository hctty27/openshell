import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, FolderOpen, X } from "lucide-react";
import { api, errorText, listen } from "../bridge";
import { t } from "../i18n";
import type { NativeZmodemReadiness, Ref } from "../types";
import ModalSurface from "./ModalSurface";

interface Props {
  refID: Ref;
  sessionName: string;
  initialDirection?: Direction;
  initialRemotePath?: string;
  onDismiss(): void;
  onError(error: unknown): void;
}

type Direction = "upload" | "download";

type TransferProgress = { processed: number; total: number };

function splitFileLines(raw: string): string[] {
  return raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${Math.round(size)} B`;
  const unit = Math.min(3, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / 1024 ** unit).toFixed(1)} ${["B", "KiB", "MiB", "GiB"][unit]}`;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

// The backend owns platform policy and the PTY lease. This view never sends
// shell commands or passes secrets; it is opened by a recognized rz/sz intent.
export default function NativeZmodemExperimentDialog({
  refID, sessionName, initialDirection, initialRemotePath, onDismiss, onError,
}: Props) {
  const [readiness, setReadiness] = useState<NativeZmodemReadiness | null>(null);
  const [direction, setDirection] = useState<Direction>(initialDirection ?? "upload");
  const [localPath, setLocalPath] = useState("");
  const [remotePath, setRemotePath] = useState(initialRemotePath ?? "");
  const [acknowledged, setAcknowledged] = useState(false);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState(false);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const cancelRequested = useRef(false);

  useEffect(() => {
    let current = true;
    void api.NativeZmodemInteractiveReadiness(refID).then(status => {
      if (current) setReadiness(status);
    }).catch(reason => {
      if (current) setError(errorText(reason));
    });
    return () => { current = false; };
  }, [refID.tabId, refID.sessionId, refID.generation]);

  useEffect(() => {
    if (!running) return;
    return listen("ssh:native-zmodem-progress", (event: {
      ref?: Ref; direction?: Direction; processed?: number; total?: number;
    }) => {
      if (event.ref?.tabId !== refID.tabId || event.ref?.sessionId !== refID.sessionId ||
        event.ref?.generation !== refID.generation || event.direction !== direction) return;
      const { processed, total } = event;
      if (typeof processed !== "number" || !Number.isFinite(processed) || processed < 0 ||
        typeof total !== "number" || !Number.isFinite(total) || total < 0 ||
        (total > 0 && processed > total)) return;
      setProgress({ processed, total });
    });
  }, [running, direction, refID.tabId, refID.sessionId, refID.generation]);

  const chooseMultiple = async () => {
    try {
      const files = await api.NativeZmodemChooseUploadFiles();
      if (files?.length) setLocalPath(files.join("\n"));
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const chooseLocal = async () => {
    try {
      const selected = direction === "upload"
        ? await api.NativeZmodemChooseUploadFile()
        : await api.SFTPChooseDirectory();
      if (selected) setLocalPath(selected);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const start = async () => {
    if (running || !readiness?.ready || !acknowledged || !localPath.trim() ||
      (direction === "download" && !remotePath.trim())) return;
    const selectedLocal = direction === "upload" ? splitFileLines(localPath) : [localPath.trim()];
    const selectedRemote = direction === "download" ? splitFileLines(remotePath) : [];
    if (!selectedLocal.length || selectedLocal.length > 100 ||
      (direction === "download" && (!selectedRemote.length || selectedRemote.length > 100))) {
      setError(t("terminal:nativeZmodemBatchLimit"));
      return;
    }
    // A previous ready status is invalid as soon as a new PTY takeover starts.
    // Keep retry disabled until the backend has checked the terminal again.
    setReadiness(null);
    setRunning(true);
    setCancelling(false);
    cancelRequested.current = false;
    setCompleted(false);
    setProgress(null);
    setStartedAt(Date.now());
    setError("");
    try {
      if (selectedLocal.length > 1 || selectedRemote.length > 1) {
        await api.StartNativeZmodemInteractiveBatchTransfer(
          refID, direction, selectedLocal, selectedRemote,
        );
      } else {
        await api.StartNativeZmodemInteractiveTransfer(
          refID, direction, selectedLocal[0], selectedRemote[0] ?? "",
        );
      }
      if (cancelRequested.current) {
        setError(t("terminal:nativeZmodemCancelUnconfirmed"));
      } else {
        setCompleted(true);
      }
    } catch (reason) {
      setError(errorText(reason));
      onError(reason);
    } finally {
      setRunning(false);
      setCancelling(false);
      try {
        setReadiness(await api.NativeZmodemInteractiveReadiness(refID));
      } catch (reason) {
        // Fail closed: an unverified terminal must not offer another takeover.
        setError(current => current || errorText(reason));
      }
    }
  };

  const cancel = async () => {
    if (!running || cancelling) return;
    setCancelling(true);
    cancelRequested.current = true;
    try {
      await api.CancelNativeZmodemInteractiveTransfer(refID);
    } catch (reason) {
      cancelRequested.current = false;
      setError(errorText(reason));
      setCancelling(false);
    }
  };

  const canStart = !completed && readiness?.ready && acknowledged && localPath.trim() &&
    (direction !== "download" || remotePath.trim());

  const elapsedSeconds = Math.max(0.1, (Date.now() - startedAt) / 1000);
  const speed = progress ? progress.processed / elapsedSeconds : 0;
  const percent = progress && progress.total > 0
    ? Math.min(99, Math.floor((progress.processed / progress.total) * 100)) : null;
  const remaining = progress && progress.total > progress.processed && speed > 0
    ? Math.ceil((progress.total - progress.processed) / speed) : null;

  return (
    <ModalSurface
      className="app-dialog native-zmodem-dialog"
      aria-label={t("terminal:nativeZmodemTitle")}
      onDismiss={onDismiss}
      locked={running}
    >
      <div className="app-dialog__header">
        <span className="app-dialog__icon"><ArrowUpFromLine size={18} /></span>
        <h2>{t("terminal:nativeZmodemTitle")}</h2>
        <button type="button" className="app-dialog__close" onClick={onDismiss}
          aria-label={t("common:closeDialog")} disabled={running}><X size={18} /></button>
      </div>
      <div className="app-dialog__body native-zmodem-dialog__body">
        <p className="app-dialog__description">
          {t("terminal:nativeZmodemSession", { name: sessionName })}
        </p>
        <p className="native-zmodem-dialog__warning">
          {t("terminal:nativeZmodemWarning")}
        </p>
        {readiness && !readiness.ready && (
          <p role="alert" className="native-zmodem-dialog__error">{readiness.message}</p>
        )}
        <fieldset className="native-zmodem-dialog__directions" disabled={running}>
          <label>
            <input type="radio" name="native-zmodem-direction" value="upload"
              checked={direction === "upload"}
              onChange={() => { setDirection("upload"); setLocalPath(""); setError(""); }} />
            <ArrowUpFromLine size={15} /> {t("terminal:nativeZmodemUpload")}
          </label>
          <label>
            <input type="radio" name="native-zmodem-direction" value="download"
              checked={direction === "download"}
              onChange={() => { setDirection("download"); setLocalPath(""); setError(""); }} />
            <ArrowDownToLine size={15} /> {t("terminal:nativeZmodemDownload")}
          </label>
        </fieldset>
        {direction === "download" && (
          <label className="app-dialog__field">
            <span>{t("terminal:nativeZmodemRemoteFile")}</span>
            <textarea value={remotePath} spellCheck={false} rows={2}
              disabled={running} placeholder="/home/user/example.bin"
              onChange={event => setRemotePath(event.target.value)} />
            <small className="native-zmodem-dialog__hint">{t("terminal:nativeZmodemBatchRemoteHint")}</small>
          </label>
        )}
        <label className="app-dialog__field">
          <span>{t(direction === "upload" ? "terminal:nativeZmodemLocalFile" : "terminal:nativeZmodemLocalFolder")}</span>
          <div className="native-zmodem-dialog__picker">
            {direction === "upload" ? (
              <textarea value={localPath} spellCheck={false} disabled={running} rows={2}
                placeholder={t("terminal:nativeZmodemChoosePath")}
                onChange={event => setLocalPath(event.target.value)} />
            ) : (
              <input type="text" value={localPath} spellCheck={false} disabled={running}
                placeholder={t("terminal:nativeZmodemChoosePath")}
                onChange={event => setLocalPath(event.target.value)} />
            )}
            <button type="button" onClick={() => void chooseLocal()} disabled={running}
              aria-label={t("terminal:nativeZmodemBrowse")}><FolderOpen size={16} /></button>
            {direction === "upload" && (
              <button type="button" onClick={() => void chooseMultiple()} disabled={running}
                aria-label={t("terminal:nativeZmodemBrowseMultiple")}>
                {t("terminal:nativeZmodemBrowseMultiple")}
              </button>
            )}
          </div>
        </label>
        {direction === "upload" && (
          <p className="native-zmodem-dialog__hint">{t("terminal:nativeZmodemUploadDirectory")} {t("terminal:nativeZmodemBatchUploadHint")}</p>
        )}
        <label className="native-zmodem-dialog__acknowledge">
          <input type="checkbox" checked={acknowledged} disabled={running}
            onChange={event => setAcknowledged(event.target.checked)} />
          {t("terminal:nativeZmodemConfirm")}
        </label>
        {running && <p role="status">{t(cancelling ? "terminal:nativeZmodemCancelling" : "terminal:nativeZmodemRunning")}</p>}
        {running && progress && (
          <div className="native-zmodem-dialog__progress" role="status">
            {percent !== null && (
              <>
                <div className="native-zmodem-dialog__progress-top">
                  <span>{t("terminal:nativeZmodemProgress")}</span>
                  <strong>{percent}%</strong>
                </div>
                <progress max={100} value={percent} aria-label={t("terminal:nativeZmodemProgress")} />
              </>
            )}
            <div className="native-zmodem-dialog__progress-details">
              {formatBytes(progress.processed)}{progress.total > 0 ? ` / ${formatBytes(progress.total)}` : ""}
              {" · "}{formatBytes(speed)}/s
              {remaining !== null ? ` · ${t("terminal:nativeZmodemETA", { seconds: remaining })}` : ""}
            </div>
            <small>{t("terminal:nativeZmodemProgressHint")}</small>
          </div>
        )}
        {completed && (
          <div className="native-zmodem-dialog__success" role="status">
            {t("terminal:nativeZmodemCompleted")}
            <small>{(direction === "upload" ? splitFileLines(localPath) : splitFileLines(remotePath)).length > 1
              ? t("terminal:nativeZmodemBatchCompleted", {
                count: (direction === "upload" ? splitFileLines(localPath) : splitFileLines(remotePath)).length,
              })
              : fileName(direction === "upload" ? localPath : remotePath)}</small>
          </div>
        )}
        {error && <p role="alert" className="native-zmodem-dialog__error">{error}</p>}
      </div>
      <div className="app-dialog__actions">
        {completed ? null : running ? (
          <button type="button" className="app-dialog__secondary" disabled={cancelling}
            onClick={() => void cancel()}>{t(cancelling ? "terminal:nativeZmodemCancelling" : "terminal:cancelZmodem")}</button>
        ) : (
          <button type="button" className="app-dialog__secondary" onClick={onDismiss}>{t("common:closeDialog")}</button>
        )}
        {completed ? (
          <button type="button" className="app-dialog__primary" onClick={onDismiss}>
            {t("terminal:nativeZmodemDone")}
          </button>
        ) : (
          <button type="button" className="app-dialog__primary" disabled={running || !canStart}
            onClick={() => void start()}>{t("terminal:nativeZmodemStart")}</button>
        )}
      </div>
    </ModalSurface>
  );
}
