import { useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronUp, X, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, errorText, listen } from "../bridge";
import type { Ref, SFTPTask } from "../types";

interface Props {
  refID?: Ref;
  onNotice(error: unknown): void;
}
interface ZmodemStats { transferred: string; speed: string }
const sameRef = (a: Ref | undefined, b: Ref | undefined) =>
  Boolean(a && b && a.tabId === b.tabId && a.sessionId === b.sessionId && a.generation === b.generation);
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1048576).toFixed(1)} MB`;

export default function TransferDock({ refID, onNotice }: Props) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<SFTPTask[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [zmodemActive, setZmodemActive] = useState(false);
  const [zmodemCancelling, setZmodemCancelling] = useState(false);
  const [zmodemStats, setZmodemStats] = useState<ZmodemStats | null>(null);
  const [zmodemEnded, setZmodemEnded] = useState(false);
  useEffect(() => {
    let disposed = false;
    setTasks([]);
    setZmodemActive(false);
    setZmodemCancelling(false);
    setZmodemStats(null);
    setZmodemEnded(false);
    if (!refID) return;
    void api.SFTPTransfers(refID).then(list => {
      if (!disposed) setTasks(list ?? []);
    }).catch(() => {});
    const offTasks = listen("sftp:transfer", (task: SFTPTask) => {
      if (!sameRef(task.ref, refID)) return;
      setTasks(old => [...old.filter(item => item.id !== task.id), task].sort((a, b) => a.created - b.created));
      if (task.status === "running" || task.status === "failed") setExpanded(true);
    });
    const offState = listen("ssh:transfer-state", (payload: { ref: Ref; active: boolean }) => {
      if (!sameRef(payload?.ref, refID)) return;
      setZmodemActive(payload.active);
      setZmodemCancelling(false);
      setZmodemStats(null);
      if (payload.active) {
        setZmodemEnded(false);
        setExpanded(true);
      } else {
        setZmodemEnded(old => old || true);
      }
    });
    const offProgress = listen("ssh:transfer-progress", (payload: { ref: Ref; transferred: string; speed: string }) => {
      if (!sameRef(payload?.ref, refID)) return;
      setZmodemStats({ transferred: payload.transferred, speed: payload.speed });
    });
    return () => {
      disposed = true;
      offTasks();
      offState();
      offProgress();
    };
  }, [refID?.tabId, refID?.sessionId, refID?.generation]);

  if (!refID || (tasks.length === 0 && !zmodemActive && !zmodemEnded)) return null;
  const running = tasks.filter(task => task.status === "running" || task.status === "queued").length + Number(zmodemActive);
  const retry = (task: SFTPTask, resume: boolean) => {
    void api.SFTPTransfer(refID, task.direction, task.source, task.destination, task.overwrite, resume).catch(onNotice);
  };
  return (
    <section className="transfer-dock" aria-label={t("sftp:transferQueue")}>
      <button type="button" className="transfer-dock-heading" aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}>
        <span>{t("sftp:transferQueue")} ({running ? `${running} / ${tasks.length + Number(zmodemActive)}` : tasks.length + Number(zmodemEnded)})</span>
        {expanded ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
      </button>
      {expanded && <div className="transfer-dock-items">
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
        {!zmodemActive && zmodemEnded && (
          <div className="transfer-dock-item">
            <span>ZMODEM</span>
            <span>{t("sftp:zmodemEnded")}</span>
            <span>{t("sftp:checkTerminalResult")}</span>
            <button type="button" aria-label={t("sftp:dismissZmodem")} onClick={() => setZmodemEnded(false)}><X size={13} /></button>
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
