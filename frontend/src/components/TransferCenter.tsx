import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpDown, ArrowUpFromLine, Check, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, desktop, errorText, listen } from "../bridge";
import { t } from "../i18n";
import type { Ref, SFTPTask, Tab } from "../types";
import { mergeTransferHistory } from "../features/transfers/transferHistory";

type Direction = "upload" | "download";
interface NativeFile {
  name: string;
  total: number | null;
  bytes: number;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
}

interface NativeBatch {
  id: string;
  ref: Ref;
  direction: Direction;
  overwrite?: boolean;
  status: "running" | "cancelling" | "completed" | "failed" | "cancelled";
  files: NativeFile[];
  error?: string;
  bytes: number;
  total: number | null;
  speed?: string;
}

interface Props {
  tabs: Tab[];
  onNotice(error: unknown): void;
}

const refKey = (ref: Ref) => `${ref.tabId}:${ref.sessionId}:${ref.generation}`;
const activeSftp = (task: SFTPTask) => task.status === "queued" || task.status === "running";
const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ?
    `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

export default function TransferCenter({ tabs, onNotice }: Props) {
  useTranslation();
  const [open, setOpen] = useState(false);
  const [nativeBatches, setNativeBatches] = useState<Record<string, NativeBatch>>({});
  const nativeRate = useRef(new Map<string, { bytes: number; time: number; speed?: string }>());
  // Keep terminal outcomes after their rows disappear: a late "start" must
  // not resurrect an already-finished native ZMODEM task.
  const nativeLastSequence = useRef(new Map<string, number>());
  const nativeFinished = useRef(new Set<string>());
  const [sftpJobs, setSftpJobs] = useState<Record<string, SFTPTask>>({});
  const [sftpConcurrency, setSftpConcurrency] = useState(3);
  const [savingConcurrency, setSavingConcurrency] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const liveRefs = tabs.filter(tab => tab.ref).map(tab => tab.ref!);
  const refIDs = liveRefs.map(refKey).sort().join("|");

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void api.SFTPConcurrency().then(value => {
      if (active && [1, 2, 3, 4, 6].includes(value)) setSftpConcurrency(value);
    }).catch(onNotice);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const offNativeBatch = listen("ssh:native-zmodem-batch", (event: {
      ref: Ref; id: string; sequence?: number; direction: Direction; active: boolean;
      files?: { name: string; total?: number }[]; error?: string; cancelled?: boolean; terminalSafe?: boolean; overwrite?: boolean;
    }) => {
      if (!event?.ref || !event.id || (event.active && event.files?.length !== 1)) return;
      const key = refKey(event.ref);
      const sequence = typeof event.sequence === "number" && Number.isSafeInteger(event.sequence) && event.sequence > 0
        ? event.sequence : 0;
      const latest = nativeLastSequence.current.get(key) ?? 0;
      if (sequence < latest) return;
      if (sequence > latest) nativeLastSequence.current.set(key, sequence);
      const identity = key + ":" + event.id;
      if (event.active && nativeFinished.current.has(identity)) return;
      if (!event.active) {
        nativeFinished.current.add(identity);
        // Bounded tombstones survive the transfer row's timed removal.
        while (nativeFinished.current.size > 512) {
          const oldest = nativeFinished.current.values().next().value;
          if (oldest === undefined) break;
          nativeFinished.current.delete(oldest);
        }
      }
      nativeRate.current.delete(key);
      setNativeBatches(previous => {
        if (event.active) {
          if (previous[key]?.id === event.id) return previous;
          return { ...previous, [key]: {
            id: event.id, ref: event.ref, direction: event.direction, overwrite: event.overwrite === true, status: "running",
            files: (event.files ?? []).map(file => ({
              name: file.name, total: typeof file.total === "number" ? file.total : null,
              bytes: 0, status: "queued",
            })), bytes: 0, total: null,
          }};
        }
        const existing = previous[key];
        if (!existing || existing.id !== event.id || (existing.status !== "running" && existing.status !== "cancelling")) return previous;
        const status = event.cancelled ? "cancelled" : event.error ? "failed" : "completed";
        return { ...previous, [key]: { ...existing, status, error: event.error,
          files: existing.files.map(file =>
            file.status === "queued" || file.status === "running" ||
            (event.error && existing.direction === "download" && file.status === "completed")
              ? { ...file, status: status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed" } : file),
        }};
      });
    });
    const offNativeFile = listen("ssh:native-zmodem-file", (event: {
      ref: Ref; batchId: string; kind: "start" | "progress" | "completed" | "skipped";
      index: number; name?: string; total?: number | null; processed?: number;
    }) => {
      if (!event?.ref || event.index !== 0) return;
      const key = refKey(event.ref);
      setNativeBatches(previous => {
        const task = previous[key];
        if (!task || task.id !== event.batchId || task.status !== "running") return previous;
        const file = task.files[0];
        if (!file || file.status === "completed" || file.status === "cancelled" || file.status === "failed") return previous;
        const processed = typeof event.processed === "number" && Number.isSafeInteger(event.processed) && event.processed >= 0
          ? event.processed : file.bytes;
        const total = typeof event.total === "number" && Number.isSafeInteger(event.total) && event.total >= 0
          ? event.total : file.total;
        return { ...previous, [key]: { ...task, files: [{
          ...file,
          name: event.name || file.name,
          total,
          bytes: Math.max(file.bytes, processed),
          status: event.kind === "completed" ? "completed" :
            event.kind === "skipped" ? "failed" : "running",
        }] } };
      });
    });
    const offNativeProgress = listen("ssh:native-zmodem-progress", (event: {
      ref: Ref; batchId: string; processed: number; total: number;
    }) => {
      if (!event?.ref || !Number.isSafeInteger(event.processed) || event.processed < 0 ||
        !Number.isSafeInteger(event.total) || event.total < 0 ||
        (event.total > 0 && event.processed > event.total)) return;
      const key = refKey(event.ref);
      setNativeBatches(previous => {
        const batch = previous[key];
        if (!batch || batch.id !== event.batchId || batch.status !== "running" ||
          event.processed < batch.bytes) return previous;
        const now = Date.now();
        const sample = nativeRate.current.get(key);
        let speed = sample?.speed;
        if (!sample || event.processed < sample.bytes) {
          nativeRate.current.set(key, { bytes: event.processed, time: now });
        } else if (now - sample.time >= 250) {
          speed = formatSize(Math.max(0, (event.processed - sample.bytes) * 1000 / (now - sample.time))) + "/s";
          nativeRate.current.set(key, { bytes: event.processed, time: now, speed });
        }
        return { ...previous, [key]: {
          ...batch, bytes: event.processed,
          total: event.total > 0 ? event.total : batch.total, speed,
        } };
      });
    });
    const offSftp = listen("sftp:transfer", (task: SFTPTask) => {
      if (!task?.id || !task.ref) return;
      setSftpJobs(previous => Object.fromEntries(
        mergeTransferHistory(Object.values(previous), [task]).map(item => [item.id, item]),
      ));
    });
    return () => {
      offNativeBatch(); offNativeFile(); offNativeProgress(); offSftp();
    };
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    for (const ref of liveRefs) {
      void api.SFTPTransfers(ref).then(tasks => {
        if (cancelled) return;
        setSftpJobs(previous => {
          const next = { ...previous };
          for (const task of tasks ?? []) {
            if (!next[task.id]) next[task.id] = task;
          }
          return Object.fromEntries(
            mergeTransferHistory([], Object.values(next)).map(item => [item.id, item]),
          );
        });
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [refIDs]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNativeBatches(previous => {
        const next = { ...previous };
        for (const [key, batch] of Object.entries(previous)) {
          if (batch.status !== "running" && batch.status !== "cancelling") delete next[key];
        }
        return Object.keys(next).length === Object.keys(previous).length ? previous : next;
      });
      setSftpJobs(previous => {
        const completed = Object.values(previous).filter(task => task.status === "completed");
        if (!completed.length) return previous;
        const next = { ...previous };
        for (const task of completed) delete next[task.id];
        return next;
      });
    }, 20000);
    return () => window.clearInterval(timer);
  }, []);

  const native = useMemo(() => Object.entries(nativeBatches)
    .filter(([key]) => liveRefs.some(ref => refKey(ref) === key))
    .map(([key, batch]) => ({ key, batch })), [nativeBatches, refIDs]);
  const sftp = useMemo(() => Object.values(sftpJobs)
    .filter(task => liveRefs.some(ref => refKey(ref) === refKey(task.ref)))
    .sort((a, b) => b.created - a.created), [sftpJobs, refIDs]);
  const running = native.filter(({ batch }) =>
    batch.status === "running" || batch.status === "cancelling").length +
    sftp.filter(activeSftp).length;
  const visibleSftp = [...sftp.filter(activeSftp), ...sftp.filter(task => !activeSftp(task))].slice(0, 30);
  const sftpGroupKey = (task: SFTPTask) => task.batchId
    ? refKey(task.ref) + ":batch:" + task.batchId : "single:" + task.id;
  const allByGroup = new Map<string, SFTPTask[]>();
  for (const task of sftp) {
    const key = sftpGroupKey(task);
    const group = allByGroup.get(key) ?? [];
    group.push(task);
    allByGroup.set(key, group);
  }
  const visibleByGroup = new Map<string, SFTPTask[]>();
  for (const task of visibleSftp) {
    const key = sftpGroupKey(task);
    const group = visibleByGroup.get(key) ?? [];
    group.push(task);
    visibleByGroup.set(key, group);
  }
  const groupedSftp = [...visibleByGroup].map(([key, tasks]) => ({
    key, tasks, allTasks: allByGroup.get(key) ?? tasks,
    batchId: tasks[0].batchId, ref: tasks[0].ref, direction: tasks[0].direction,
  }));
  const changeConcurrency = (next: number) => {
    const previous = sftpConcurrency;
    setSftpConcurrency(next);
    setSavingConcurrency(true);
    void api.SetSFTPConcurrency(next).catch(error => {
      setSftpConcurrency(previous);
      onNotice(error);
    }).finally(() => setSavingConcurrency(false));
  };
  const sessionName = (ref: Ref) =>
    tabs.find(tab => tab.ref && refKey(tab.ref) === refKey(ref))?.session.name ?? ref.sessionId;

  const cancelNative = (key: string, batch: NativeBatch) => {
    setNativeBatches(previous => previous[key]?.id === batch.id ? ({
      ...previous, [key]: { ...previous[key], status: "cancelling" },
    }) : previous);
    void api.CancelNativeZmodemInteractiveTransfer(batch.ref).catch(error => {
      setNativeBatches(previous => previous[key]?.id === batch.id && previous[key]?.status === "cancelling" ? ({
        ...previous, [key]: { ...previous[key], status: "failed", error: "取消请求未确认：" + errorText(error) },
      }) : previous);
      onNotice(error);
    });
  };

  return (
    <div className="transfer-center" ref={panel}>
      <button type="button" className="transfer-center-toggle"
        title={t("sftp:transferQueue")} aria-label={t("sftp:transferQueue")}
        aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <ArrowUpDown size={16} />
        {running > 0 && <span className="transfer-center-count">{running}</span>}
      </button>
      {open && (
        <section className="transfer-center-popover" aria-label={t("sftp:transferQueue")}>
          <header>
            <strong>{t("sftp:transferQueue")}</strong>
            <span>{t("sftp:transferActive", { count: running })}</span>
            <button type="button" aria-label={t("sftp:zmodemDialogClose")}
              onClick={() => setOpen(false)}><X size={15} /></button>
          </header>
          <div className="transfer-center-list">
            {native.length === 0 && visibleSftp.length === 0 && (
              <p className="transfer-center-empty">{t("sftp:noTransfers")}</p>
            )}
            {native.map(({ key, batch }) => {
              const file = batch.files[0];
              const total = file?.total ?? batch.total;
              const bytes = Math.max(batch.bytes, file?.bytes ?? 0);
              // Wire completion is not remote confirmation. Never report 100%
              // until the backend has restored the shell and published the file.
              const percent = batch.status === "completed" ? 100 :
                total == null ? null : total === 0 ? 0 :
                  Math.min(99, Math.round(bytes / total * 100));
              const active = batch.status === "running" || batch.status === "cancelling";
              const statusLabel = batch.status === "completed" ? t("sftp:completed") :
                batch.status === "failed" ? t("sftp:failed") :
                batch.status === "cancelled" ? t("sftp:cancelled") :
                batch.status === "cancelling" ? t("terminal:zmodemCancelling") :
                total !== null && bytes >= total ? "等待远端确认" :
                percent === null ? t("sftp:running") : percent + "%";
              return (
                <article key={"native-" + key} className="transfer-center-job">
                  <div className="transfer-center-line">
                    {batch.direction === "download" ? <ArrowDownToLine size={15}/> : <ArrowUpFromLine size={15}/>}
                    <strong title={file?.name ?? "ZMODEM"}>{file?.name ?? "ZMODEM"}{batch.overwrite ? " · " + t("sftp:zmodemOverwriteMode") : ""}</strong>
                    <span className="transfer-center-session" title={sessionName(batch.ref)}>{sessionName(batch.ref)}</span>
                    {active ?
                      <button type="button" disabled={batch.status === "cancelling"}
                        title={t("sftp:cancelTransfer")} onClick={() => cancelNative(key, batch)}><X size={14}/></button> :
                      batch.status === "completed" ? <Check size={15}/> : <X size={15}/>}
                  </div>
                  <div className={"transfer-center-bar" + (percent === null && active ? " indeterminate" : "")}
                    role="progressbar" aria-valuemin={0} aria-valuemax={percent === null ? undefined : 100}
                    aria-valuenow={percent === null ? undefined : percent}>
                    <div style={percent === null ? undefined : { width: String(percent) + "%" }}/>
                  </div>
                  <div className="transfer-center-metrics">
                    <span>{formatSize(bytes)} / {total == null ? t("sftp:transferUnknownProgress") : formatSize(total)}
                      {batch.speed && active ? " · " + batch.speed : ""}</span>
                    <span title={batch.error}>{statusLabel}</span>
                  </div>
                  {batch.error && <div className="transfer-center-terminal-error" title={batch.error}>{batch.error}</div>}
                </article>
              );
            })}
            {groupedSftp.map(group => {
              const active = group.allTasks.filter(activeSftp).length;
              const completed = group.allTasks.filter(task => task.status === "completed").length;
              const totalKnown = group.allTasks.every(task => task.total > 0 || task.status === "completed");
              const totalBytes = group.allTasks.reduce((sum, task) => sum + task.total, 0);
              const doneBytes = group.allTasks.reduce((sum, task) => sum + task.bytes, 0);
              const percent = totalKnown && totalBytes > 0
                ? Math.min(100, Math.round(doneBytes / totalBytes * 100))
                : totalKnown && active === 0 ? 100 : null;
              return (
                <div className="transfer-center-sftp-group" key={group.key}>
                  {group.batchId && group.allTasks.length > 1 && (
                    <div className="transfer-center-sftp-batch">
                      <div className="transfer-center-line">
                        {group.direction === "upload" ? <ArrowUpFromLine size={15}/> : <ArrowDownToLine size={15}/>}
                        <strong>SFTP · {group.allTasks.length} {t("sftp:batchFiles")}</strong>
                        <span className="transfer-center-session" title={sessionName(group.ref)}>{sessionName(group.ref)}</span>
                        {active > 0 && <button type="button" title={t("sftp:cancelBatch")}
                          aria-label={t("sftp:cancelBatch")}
                          onClick={() => void api.SFTPCancelBatch(group.ref, group.batchId!).catch(onNotice)}><X size={14}/></button>}
                      </div>
                      <div className={"transfer-center-bar" + (percent == null && active > 0 ? " indeterminate" : "")}
                        role="progressbar" aria-valuemin={0} aria-valuemax={100}
                        aria-valuenow={percent == null ? undefined : percent}>
                        <div style={percent == null ? undefined : {width: percent + "%"}}/>
                      </div>
                      <div className="transfer-center-metrics">
                        <span>{completed} / {group.allTasks.length} {t("sftp:batchCompleted")}</span>
                        <span>{percent == null ? t("sftp:transferUnknownProgress") : percent + "%"}</span>
                      </div>
                    </div>
                  )}
                  {group.tasks.map(task => {
              const percent = task.total > 0 ?
                Math.max(0, Math.min(100, Math.round(task.bytes / task.total * 100))) : null;
              return (
                <article key={task.id} className="transfer-center-job">
                  <div className="transfer-center-line">
                    {task.direction === "upload" ? <ArrowUpFromLine size={15} /> : <ArrowDownToLine size={15} />}
                    <strong title={task.name}>{task.name}</strong>
                    <span className="transfer-center-session" title={sessionName(task.ref)}>{sessionName(task.ref)}</span>
                    {activeSftp(task) ?
                      <button type="button" title={t("sftp:cancelTransfer")}
                        onClick={() => void api.SFTPCancel(task.id).catch(onNotice)}><X size={14} /></button> :
                    task.status === "failed" || task.status === "cancelled" ?
                      <button type="button" title={t("sftp:resumeTransfer")} onClick={() =>
                        void api.SFTPTransfer(task.ref, task.direction, task.source,
                          task.destination, task.overwrite, true).catch(onNotice)
                      }><RotateCcw size={14} /></button> : <Check size={15} />}
                  </div>
                  <div className={`transfer-center-bar ${percent == null && activeSftp(task) ? "indeterminate" : ""}`}
                    role="progressbar" aria-valuemin={0} aria-valuemax={percent == null ? undefined : 100}
                    aria-valuenow={percent == null ? undefined : percent}>
                    <div style={percent == null ? undefined : { width: `${percent}%` }} />
                  </div>
                  <div className="transfer-center-metrics">
                    <span title={task.error ? errorText(task.error) : undefined}>
                      {formatSize(task.bytes)} / {task.total > 0 ? formatSize(task.total) : "—"}
                    </span>
                    <span>{percent == null ? t(`sftp:${task.status}`) : `${percent}%`}</span>
                  </div>
                </article>
              );
                  })}
                </div>
              );
            })}
          </div>
          <footer className="transfer-center-settings">
            <label>
              {t("sftp:concurrencyLabel")}
              <select aria-label={t("sftp:concurrencyLabel")} value={sftpConcurrency}
                disabled={savingConcurrency} onChange={event => changeConcurrency(Number(event.target.value))}>
                {[1,2,3,4,6].map(value => <option value={value} key={value}>{value}</option>)}
              </select>
            </label>
            <span title={t("sftp:concurrencyHint")}>{t("sftp:concurrencyHint")}</span>
          </footer>
        </section>
      )}
    </div>
  );
}
