import { useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, FolderOpen, X } from "lucide-react";
import { api, errorText } from "../bridge";
import { t } from "../i18n";
import type { NativeZmodemReadiness, Ref } from "../types";
import ModalSurface from "./ModalSurface";

interface Props {
  refID: Ref;
  sessionName: string;
  onDismiss(): void;
  onNotice(message: unknown): void;
}

type Direction = "upload" | "download";

// The backend owns the opt-in gate and PTY lease. This view never sends
// shell commands, passes secrets, or changes the existing rz/sz default.
export default function NativeZmodemExperimentDialog({
  refID, sessionName, onDismiss, onNotice,
}: Props) {
  const [readiness, setReadiness] = useState<NativeZmodemReadiness | null>(null);
  const [direction, setDirection] = useState<Direction>("upload");
  const [localPath, setLocalPath] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    let current = true;
    void api.NativeZmodemInteractiveReadiness(refID).then(status => {
      if (current) setReadiness(status);
    }).catch(reason => {
      if (current) setError(errorText(reason));
    });
    return () => { current = false; };
  }, [refID.tabId, refID.sessionId, refID.generation]);

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
    setRunning(true);
    setCancelling(false);
    setCompleted(false);
    setError("");
    try {
      await api.StartNativeZmodemInteractiveTransfer(
        refID, direction, localPath.trim(), direction === "download" ? remotePath.trim() : "",
      );
      setCompleted(true);
      onNotice(t("terminal:nativeZmodemCompleted"));
    } catch (reason) {
      setError(errorText(reason));
      onNotice(reason);
    } finally {
      setRunning(false);
      setCancelling(false);
      void api.NativeZmodemInteractiveReadiness(refID).then(setReadiness).catch(() => {});
    }
  };

  const cancel = async () => {
    if (!running || cancelling) return;
    setCancelling(true);
    try {
      await api.CancelNativeZmodemInteractiveTransfer(refID);
    } catch (reason) {
      setError(errorText(reason));
      setCancelling(false);
    }
  };

  const canStart = readiness?.ready && acknowledged && localPath.trim() &&
    (direction !== "download" || remotePath.trim());

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
            <input type="text" value={remotePath} spellCheck={false}
              disabled={running} placeholder="/home/user/example.bin"
              onChange={event => setRemotePath(event.target.value)} />
          </label>
        )}
        <label className="app-dialog__field">
          <span>{t(direction === "upload" ? "terminal:nativeZmodemLocalFile" : "terminal:nativeZmodemLocalFolder")}</span>
          <div className="native-zmodem-dialog__picker">
            <input type="text" value={localPath} spellCheck={false} disabled={running}
              placeholder={t("terminal:nativeZmodemChoosePath")}
              onChange={event => setLocalPath(event.target.value)} />
            <button type="button" onClick={() => void chooseLocal()} disabled={running}
              aria-label={t("terminal:nativeZmodemBrowse")}><FolderOpen size={16} /></button>
          </div>
        </label>
        {direction === "upload" && (
          <p className="native-zmodem-dialog__hint">{t("terminal:nativeZmodemUploadDirectory")}</p>
        )}
        <label className="native-zmodem-dialog__acknowledge">
          <input type="checkbox" checked={acknowledged} disabled={running}
            onChange={event => setAcknowledged(event.target.checked)} />
          {t("terminal:nativeZmodemConfirm")}
        </label>
        {running && <p role="status">{t(cancelling ? "terminal:nativeZmodemCancelling" : "terminal:nativeZmodemRunning")}</p>}
        {completed && <p role="status">{t("terminal:nativeZmodemCompleted")}</p>}
        {error && <p role="alert" className="native-zmodem-dialog__error">{error}</p>}
      </div>
      <div className="app-dialog__actions">
        {running ? (
          <button type="button" className="app-dialog__secondary" disabled={cancelling}
            onClick={() => void cancel()}>{t(cancelling ? "terminal:nativeZmodemCancelling" : "terminal:cancelZmodem")}</button>
        ) : (
          <button type="button" className="app-dialog__secondary" onClick={onDismiss}>{t("common:closeDialog")}</button>
        )}
        <button type="button" className="app-dialog__primary" disabled={running || !canStart}
          onClick={() => void start()}>{t("terminal:nativeZmodemStart")}</button>
      </div>
    </ModalSurface>
  );
}
