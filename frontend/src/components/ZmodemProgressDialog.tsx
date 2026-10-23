import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, FileArchive, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import { api, listen } from "../bridge";
import type { Ref } from "../types";

type Direction = "upload" | "download";
type Status = "waiting" | "running" | "cancelling" | "cancelled" | "ended";

interface ZmodemTransfer {
  ref: Ref;
  status: Status;
  direction?: Direction;
  transferred?: string;
  speed?: string;
  hasProgress: boolean;
}

interface Props {
  activeRef?: Ref;
  onNotice(error: unknown): void;
}

const transferKey = (ref: Ref) =>
  [ref.tabId, ref.sessionId, ref.generation].join(":");

const initialTransfer = (ref: Ref): ZmodemTransfer => ({
  ref,
  status: "waiting",
  hasProgress: false,
});

/**
 * The upstream legacy ZMODEM implementation reports approximate transferred
 * bytes/speed, but does not expose a reliable filename or total byte count.
 * Never fabricate either of those values or a completion percentage.
 */
export default function ZmodemProgressDialog({ activeRef, onNotice }: Props) {
  useTranslation();
  const [transfers, setTransfers] = useState<Record<string, ZmodemTransfer>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [autoClose, setAutoClose] = useState(true);
  const dismissed = useRef(new Set<string>());
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const offDetails = listen("ssh:transfer-details", (payload: {
      ref: Ref;
      direction: Direction;
    }) => {
      if (!payload?.ref || !["upload", "download"].includes(payload.direction)) return;
      const key = transferKey(payload.ref);
      setTransfers(current => ({
        ...current,
        [key]: {
          ...(current[key] ?? initialTransfer(payload.ref)),
          direction: payload.direction,
        },
      }));
    });

    const offState = listen("ssh:transfer-state", (payload: {
      ref: Ref;
      active: boolean;
    }) => {
      if (!payload?.ref) return;
      const key = transferKey(payload.ref);
      if (payload.active) {
        dismissed.current.delete(key);
        setTransfers(current => ({
          ...current,
          [key]: { ...initialTransfer(payload.ref), direction: current[key]?.direction },
        }));
      } else {
        setTransfers(current => {
          const transfer = current[key];
          if (!transfer) return current;
          return {
            ...current,
            [key]: {
              ...transfer,
              status: transfer.status === "cancelling" ? "cancelled" : "ended",
            },
          };
        });
        if (autoClose) setOpenKey(current => current === key ? null : current);
      }
    });

    const offProgress = listen("ssh:transfer-progress", (payload: {
      ref: Ref;
      transferred: string;
      speed: string;
    }) => {
      if (!payload?.ref) return;
      const key = transferKey(payload.ref);
      setTransfers(current => ({
        ...current,
        [key]: {
          ...(current[key] ?? initialTransfer(payload.ref)),
          status: "running",
          transferred: payload.transferred,
          speed: payload.speed,
          hasProgress: true,
        },
      }));
      // ZMODEM invokes the native file picker first; do not cover that picker.
      if (!dismissed.current.has(key)) setOpenKey(key);
    });

    return () => { offDetails(); offState(); offProgress(); };
  }, [autoClose]);

  const key = activeRef ? transferKey(activeRef) : undefined;
  const transfer = key ? transfers[key] : undefined;
  const showDialog = Boolean(key && transfer?.hasProgress && openKey === key);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!showDialog || !dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
    };
  }, [showDialog, key]);

  if (!key || !transfer?.hasProgress) return null;
  const isActive = ["waiting", "running", "cancelling"].includes(transfer.status);
  const close = () => {
    dismissed.current.add(key);
    setOpenKey(null);
  };
  const cancel = () => {
    if (!activeRef || !isActive || transfer.status === "cancelling") return;
    setTransfers(current => ({
      ...current,
      [key]: { ...current[key], status: "cancelling" },
    }));
    void api.CancelZmodem(activeRef).catch(error => {
      setTransfers(current => ({
        ...current,
        [key]: { ...current[key], status: "running" },
      }));
      onNotice(error);
    });
  };

  const directionLabel = transfer.direction === "upload"
    ? t("sftp:zmodemDialogUpload")
    : transfer.direction === "download"
      ? t("sftp:zmodemDialogDownload")
      : t("sftp:zmodemDialogTitle");
  const description = transfer.status === "cancelling"
    ? t("sftp:zmodemDialogCanceling")
    : transfer.status === "cancelled"
      ? t("sftp:zmodemDialogCancelled")
      : transfer.status === "ended"
        ? t("sftp:zmodemDialogEnding")
        : t("sftp:zmodemDialogWorking");

  return (
    <>
      {isActive && !showDialog && (
        <button className="zmodem-progress-chip"
          type="button" onClick={() => {
            dismissed.current.delete(key);
            setOpenKey(key);
          }}
          aria-label={t("sftp:zmodemDialogReopen")}>
          <FileArchive size={15} /> {t("sftp:zmodemDialogReopen")}
        </button>
      )}
      {showDialog && (
          <dialog ref={dialogRef} className="zmodem-progress-dialog"
            aria-labelledby="zmodem-progress-title"
            onCancel={event => { event.preventDefault(); close(); }}>
            <header>
              {transfer.direction === "download"
                ? <ArrowDownToLine size={18} aria-hidden="true" />
                : <ArrowUpFromLine size={18} aria-hidden="true" />}
              <h2 id="zmodem-progress-title">{directionLabel}</h2>
              <button type="button" aria-label={t("sftp:zmodemDialogClose")}
                onClick={close}><X size={17} /></button>
            </header>
            <div className="zmodem-progress-body">
              <div className="zmodem-progress-description">
                <FileArchive size={28} aria-hidden="true" />
                <div>
                  <strong>{description}</strong>
                  <span>{t("sftp:zmodemDialogIndeterminate")}</span>
                </div>
              </div>
              <div role="progressbar" className={"zmodem-progress-track" +
                (isActive ? "" : " zmodem-progress-track--ended")}
                aria-label={t("sftp:zmodemDialogTitle")}
                aria-valuetext={transfer.transferred ?? t("sftp:zmodemDialogPending")}>
                <div />
              </div>
              <dl className="zmodem-progress-fields">
                <dt>{t("sftp:zmodemDialogFilename")}</dt>
                <dd>{t("sftp:zmodemDialogUnavailable")}</dd>
                <dt>{t("sftp:zmodemDialogFilesize")}</dt>
                <dd>{t("sftp:zmodemDialogUnavailable")}</dd>
                <dt>{t("sftp:zmodemDialogTransferred")}</dt>
                <dd>{transfer.transferred ?? t("sftp:zmodemDialogPending")}</dd>
                <dt>{t("sftp:zmodemDialogSpeed")}</dt>
                <dd>{transfer.speed ?? t("sftp:zmodemDialogPending")}</dd>
              </dl>
            </div>
            <footer>
              <label>
                <input type="checkbox" checked={autoClose} onChange={event => setAutoClose(event.target.checked)} />
                {t("sftp:zmodemDialogAutoClose")}
              </label>
              <button type="button" onClick={isActive ? cancel : close}
                disabled={transfer.status === "cancelling"}>
                {isActive ? t("terminal:cancelZmodem") : t("sftp:zmodemDialogCheck")}
              </button>
            </footer>
          </dialog>
      )}
    </>
  );
}
