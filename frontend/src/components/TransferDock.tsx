import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronUp, X, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import { api, errorText, listen } from "../bridge";
import type { Ref, SFTPTask } from "../types";

interface Props {
  refID?: Ref;
  onNotice(error: unknown): void;
  alwaysVisible?: boolean;
}
interface ZmodemStats { transferred: string; speed: string }
const sameRef = (a: Ref | undefined, b: Ref | undefined) =>
  Boolean(a && b && a.tabId === b.tabId && a.sessionId === b.sessionId && a.generation === b.generation);
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1048576).toFixed(1)} MB`;

export default function TransferDock({ refID, onNotice, alwaysVisible = false }: Props) {
  useTranslation();
  const [tasks, setTasks] = useState<SFTPTask[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [zmodemActive, setZmodemActive] = useState(false);
  const [zmodemCancelling, setZmodemCancelling] = useState(false);
  const [zmodemStats, setZmodemStats] = useState<ZmodemStats | null>(null);
  const seenZmodem = useRef(false);
  const finishedZmodem = useRef(false);
  useEffect(() => {
    let disposed = false;
    setTasks([]);
    setZmodemActive(false);
    setZmodemCancelling(false);
    setZmodemStats(null);
    seenZmodem.current = false;
    finishedZmodem.current = false;
    if (!refID) return;
    // Browser fixtures can emulate SSH without exposing the SFTP backend.
    // Check the actual Wails binding before calling through the API proxy.
    if (typeof window.go?.main?.App?.SFTPTransfers === "function") {
      void api.SFTPTransfers(refID).then(list => {
        if (disposed) return;
        setTasks(current => {
          const byID = new Map((list ?? []).map(task => [task.id, task]));
          for (const task of current) byID.set(task.id, task);
          return [...byID.values()].sort((a, b) => a.created - b.created);
        });
      }).catch(() => {});
    }
    const offTasks = listen("sftp:transfer", (task: SFTPTask) => {
      if (!sameRef(task.ref, refID)) return;
      setTasks(old => [...old.filter(item => item.id !== task.id), task].sort((a, b) => a.created - b.created));
      if (task.status === "running" || task.status === "failed") setExpanded(true);
    });
    const offDetails = listen("ssh:transfer-details", (payload: { ref: Ref }) => {
      if (sameRef(payload?.ref, refID)) finishedZmodem.current = false;
    });
    const offState = listen("ssh:transfer-state", (payload: { ref: Ref; active: boolean }) => {
      if (!sameRef(payload?.ref, refID)) return;
      if (payload.active && finishedZmodem.current) return;
      if (!payload.active) finishedZmodem.current = true;
      setZmodemActive(payload.active);
      setZmodemCancelling(false);
      setZmodemStats(null);
      if (payload.active) {
        seenZmodem.current = true;
        setExpanded(true);
      } else if (seenZmodem.current) {
        seenZmodem.current = false;
      }
    });
    const offProgress = listen("ssh:transfer-progress", (payload: { ref: Ref; transferred: string; speed: string }) => {
      if (!sameRef(payload?.ref, refID) || finishedZmodem.current) return;
      setZmodemStats({ transferred: payload.transferred, speed: payload.speed });
    });
    // Upstream legacy ZMODEM may delay its transfer-state(false) callback
    // until more remote output arrives after the local child has already exited.
    const offFinished = listen("ssh:transfer-finished", (payload: { ref: Ref }) => {
      if (!sameRef(payload?.ref, refID)) return;
      finishedZmodem.current = true;
      seenZmodem.current = false;
      setZmodemActive(false);
      setZmodemCancelling(false);
      setZmodemStats(null);
    });
    return () => {
      disposed = true;
      offTasks();
      offDetails();
      offState();
      offProgress();
      offFinished();
    };
  }, [refID?.tabId, refID?.sessionId, refID?.generation]);

  if (!refID || (!alwaysVisible && tasks.length === 0 && !zmodemActive)) return null;
  const running = tasks.filter(task => task.status === "running" || task.status === "queued").length + Number(zmodemActive);
  const retry = (task: SFTPTask, resume: boolean) => {
    void api.SFTPTransfer(refID, task.direction, task.source, task.destination, task.overwrite, resume).catch(onNotice);
  };
  return (
    <section className="transfer-dock" aria-label={t("sftp:transferQueue")}>
      <button type="button" className="transfer-dock-heading" aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}>
        <span>{t("sftp:transferQueue")} ({running ? `${running} / ${tasks.length + Number(zmodemActive)}` : tasks.length})</span>
        {expanded ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
      </button>
      {expanded && <div className="transfer-dock-items">
        {tasks.length === 0 && !zmodemActive  && (
          <div className="transfer-dock-empty">{t("sftp:noTransfers")}</div>
        )}
        {zmodemActive && (
          <div className="transfer-dock-item" role="status">
            <span>ZMODEM</span>
            <span>{zmodemCancelling ? t("terminal:zmodemCancelling") : t("terminal:zmodemTransferring")}</span>
            <span>{zmodemStats ? `${zmodemStats.transferred} · ${zmodemStats.speed}` : t("sftp:estimating")}</span>
            <button type="button" disabled={zmodemCancelling} aria-label={t("terminal:cancelZmodem")}
              onClick={() => {
                setZmodemCancelling(true);
                void api.CancelZmodem(refID).catch(error => {
                  setZmodemCancelling(false);
                  onNotice(error);
                });
              }}><X size={13} /></button>
          </div>
        )}
        {[...tasks].reverse().slice(0, 40).map(task => (
          <div className="transfer-dock-item" key={task.id}>
            <span title={task.name} className="transfer-dock-name">
              {task.direction === "upload" ? <ArrowUpFromLine size={12} /> : <ArrowDownToLine size={12} />}
              {task.name}
            </span>
            <span title={task.error ? errorText(task.error) : undefined}>
              {task.error ? errorText(task.error) : t(`sftp:${task.status}`)}
            </span>
            <span className="transfer-dock-metric">
              {size(task.bytes)} / {size(task.total)}
              {task.total > 0 ? ` · ${Math.min(100, Math.round(task.bytes / task.total * 100))}%` : ""}
            </span>
            {(task.status === "running" || task.status === "queued") ?
              <button type="button" aria-label={t("sftp:cancelTransfer")} onClick={() => void api.SFTPCancel(task.id).catch(onNotice)}><X size={13} /></button> :
              (task.status === "failed" || task.status === "cancelled") ?
                <button type="button" aria-label={t("sftp:resumeTransfer")} onClick={() => retry(task, true)}><RotateCcw size={13} /></button> :
                <span />}
          </div>
        ))}
      </div>}
    </section>
  );
}
