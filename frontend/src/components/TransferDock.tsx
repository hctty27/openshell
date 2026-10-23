import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronUp, X, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import { api, errorText } from "../bridge";
import { useTransferTasks } from "../features/transfers/useTransferTasks";
import type { Ref, SFTPTask } from "../types";

interface Props {
  refID?: Ref;
  onNotice(error: unknown): void;
  alwaysVisible?: boolean;
}
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1048576).toFixed(1)} MB`;

export default function TransferDock({ refID, onNotice, alwaysVisible = false }: Props) {
  useTranslation();
  const {
    tasks, expanded, setExpanded, zmodemActive,
    zmodemCancelling, setZmodemCancelling, zmodemStats,
  } = useTransferTasks(refID);

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
