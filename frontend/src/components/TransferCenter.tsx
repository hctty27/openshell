import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpDown, ArrowUpFromLine, Check, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, desktop, errorText, listen } from "../bridge";
import { t } from "../i18n";
import type { Ref, SFTPTask, Tab } from "../types";
import { mergeTransferHistory } from "../features/transfers/transferHistory";

type Direction = "upload" | "download";
type Protocol = "zmodem" | "trzsz";
type TransferStatus = "running" | "cancelling" | "completed" | "cancelled" | "failed";

interface TerminalFile {
  name: string;
  total: number | null;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
}

interface TerminalTransfer {
  ref: Ref;
  transferId: string;
  protocol: Protocol;
  direction?: Direction;
  status: TransferStatus;
  transferred?: string;
  speed?: string;
  percent?: number;
  processed?: number;
  files: TerminalFile[];
  error?: string;
}

interface NativeFile {
  name: string;
  total: number | null;
  bytes: number;
  status: "queued" | "running" | "skipping" | "skipped" | "completed" | "cancelled" | "failed";
}

interface NativeBatch {
  id: string;
  ref: Ref;
  direction: Direction;
  status: "running" | "cancelling" | "completed" | "failed" | "cancelled";
  files: NativeFile[];
  error?: string;
  bytes: number;
  total: number | null;
}

interface Props {
  tabs: Tab[];
  onNotice(error: unknown): void;
}

const refKey = (ref: Ref) => `${ref.tabId}:${ref.sessionId}:${ref.generation}`;
const transferKey = (ref: Ref, transferId?: string) => `${refKey(ref)}:${transferId || "legacy"}`;
const activeSftp = (task: SFTPTask) => task.status === "queued" || task.status === "running";
const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ?
    `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

export default function TransferCenter({ tabs, onNotice }: Props) {
  useTranslation();
  const [open, setOpen] = useState(false);
  const [terminalJobs, setTerminalJobs] = useState<Record<string, TerminalTransfer>>({});
  const [nativeBatches, setNativeBatches] = useState<Record<string, NativeBatch>>({});
  const [sftpJobs, setSftpJobs] = useState<Record<string, SFTPTask>>({});
  const [sftpConcurrency, setSftpConcurrency] = useState(3);
  const [savingConcurrency, setSavingConcurrency] = useState(false);
  const finished = useRef(new Set<string>());
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
    const offDetails = listen("ssh:transfer-details", (event: {
      ref: Ref; transferId?: string; direction: Direction; protocol?: Protocol;
      files?: { name: string; total?: number | null }[];
    }) => {
      if (!event?.ref) return;
      const transferId = event.transferId || "legacy";
      const key = transferKey(event.ref, transferId);
      finished.current.delete(key);
      setTerminalJobs(previous => ({
        ...previous,
        [key]: {
          ref: event.ref, transferId, direction: event.direction,
          protocol: event.protocol === "trzsz" ? "trzsz" : "zmodem",
          status: "running",
          files: (event.files ?? []).map(file => ({
            name: file.name,
            total: typeof file.total === "number" ? file.total : null,
            status: "queued",
          })),
        },
      }));
    });
    const offState = listen("ssh:transfer-state", (event: {
      ref: Ref; transferId?: string; active: boolean; status?: TransferStatus;
    }) => {
      if (!event?.ref) return;
      const transferId = event.transferId || "legacy";
      const key = transferKey(event.ref, transferId);
      if (event.active) {
        if (finished.current.has(key)) return;
        setTerminalJobs(previous => {
          const job = previous[key];
          return {
            ...previous,
            [key]: {
              ...job,
              ref: event.ref, transferId,
              protocol: job?.protocol ?? "trzsz",
              direction: job?.direction,
              status: job?.status === "cancelling" ? "cancelling" : "running",
              files: job?.files ?? [],
            },
          };
        });
      } else {
        if (finished.current.has(key)) return;
        finished.current.add(key);
        setTerminalJobs(previous => {
          const job = previous[key];
          if (!job) return previous;
          const status = event.status ?? (job.status === "cancelling" ? "cancelled" : "completed");
          return {
            ...previous,
            [key]: {
              ...job, status,
              files: job.files.map(file => file.status === "completed" ? file : ({
                ...file, status: status === "completed" ? "completed" : status === "failed" ? "failed" : "cancelled",
              })),
            },
          };
        });
      }
    });
    const offProgress = listen("ssh:transfer-progress", (event: {
      ref: Ref; transferId?: string; transferred?: string; speed?: string;
      protocol?: Protocol; percent?: number; processed?: number;
    }) => {
      if (!event?.ref) return;
      const transferId = event.transferId || "legacy";
      const key = transferKey(event.ref, transferId);
      if (finished.current.has(key)) return;
      setTerminalJobs(previous => {
        const job = previous[key];
        return {
          ...previous,
          [key]: {
            ...job,
            ref: event.ref, transferId,
            protocol: event.protocol === "trzsz" ? "trzsz" : job?.protocol ?? "zmodem",
            direction: job?.direction,
            status: job?.status === "cancelling" ? "cancelling" : "running",
            transferred: event.transferred ?? job?.transferred,
            speed: event.speed ?? job?.speed,
            processed: typeof event.processed === "number" ? event.processed : job?.processed,
            percent: typeof event.percent === "number" && event.percent >= 0 &&
              event.percent <= 100 ? event.percent : job?.percent,
            files: (job?.files ?? []).map(file => file.status === "queued" ? ({
              ...file, status: "running",
            }) : file),
          },
        };
      });
    });
    const offFinished = listen("ssh:transfer-finished", (event: {
      ref: Ref; transferId?: string; status?: TransferStatus; error?: string;
    }) => {
      if (!event?.ref) return;
      const transferId = event.transferId || "legacy";
      const key = transferKey(event.ref, transferId);
      finished.current.add(key);
      setTerminalJobs(previous => {
        const job = previous[key];
        if (!job) return previous;
        const status = event.status ?? (job.status === "cancelling" ? "cancelled" : "completed");
        return {
          ...previous,
          [key]: {
            ...job, status, error: event.error,
            percent: status === "completed" ? 100 : job.percent,
            files: job.files.map(file => file.status === "completed" ? file : ({
              ...file, status: status === "completed" ? "completed" : status === "failed" ? "failed" : "cancelled",
            })),
          },
        };
      });
    });
    const offFile = listen("ssh:transfer-file", (event: {
      ref: Ref; transferId: string; kind: "start" | "completed";
      name: string; total?: number; processed?: number;
    }) => {
      if (!event?.ref || !event.transferId || !event.name) return;
      const key = transferKey(event.ref, event.transferId);
      if (finished.current.has(key)) return;
      setTerminalJobs(previous => {
        const job = previous[key];
        if (!job) return previous;
        const files = [...job.files];
        let index = files.findIndex(file => file.name === event.name && file.status !== "completed");
        if (event.kind === "start") {
          if (index < 0) {
            files.push({
              name: event.name,
              total: typeof event.total === "number" ? event.total : null,
              status: "running",
            });
          } else {
            files[index] = {
              ...files[index],
              total: typeof event.total === "number" ? event.total : files[index].total,
              status: "running",
            };
          }
        } else if (index >= 0) {
          files[index] = {
            ...files[index],
            total: typeof event.total === "number" ? event.total : files[index].total,
            status: "completed",
          };
        }
        return { ...previous, [key]: { ...job, files } };
      });
    });
    const offNativeBatch = listen("ssh:native-zmodem-batch", (event: {
      ref: Ref; id: string; direction: Direction; active: boolean;
      files?: { name: string; total?: number }[]; error?: string;
    }) => {
      if (!event?.ref || !event.id) return;
      const key = refKey(event.ref);
      setNativeBatches(previous => {
        if (event.active) {
          return { ...previous, [key]: {
            id: event.id, ref: event.ref, direction: event.direction, status: "running",
            files: (event.files ?? []).map(file => ({
              name: file.name, total: typeof file.total === "number" ? file.total : null,
              bytes: 0, status: "queued",
            })), bytes: 0, total: null,
          }};
        }
        const existing = previous[key];
        if (!existing || existing.id !== event.id) return previous;
        const status = event.error ? (existing.status === "cancelling" ? "cancelled" : "failed")
          : "completed";
        return { ...previous, [key]: { ...existing, status, error: event.error,
          files: existing.files.map(file =>
            file.status === "queued" || file.status === "running" || file.status === "skipping" ||
            (event.error && existing.direction === "download" && file.status === "completed")
              ? { ...file, status: status === "completed" ? "completed" : "failed" } : file),
        }};
      });
    });
    const offNativeFile = listen("ssh:native-zmodem-file", (event: {
      ref: Ref; batchId: string; kind: "start" | "progress" | "completed" | "skip-requested" | "skipped";
      index: number; name?: string; total?: number | null; processed?: number;
    }) => {
      if (!event?.ref || !Number.isInteger(event.index) || event.index < 0 || event.index >= 100) return;
      const key = refKey(event.ref);
      setNativeBatches(previous => {
        const batch = previous[key];
        if (!batch || batch.id !== event.batchId || batch.status !== "running") return previous;
        const files = [...batch.files];
        while (files.length <= event.index) files.push({
          name: "文件 " + (files.length + 1), total: null, bytes: 0, status: "queued",
        });
        const current = files[event.index];
        files[event.index] = {
          ...current, name: event.name || current.name,
          total: event.kind === "start" && typeof event.total === "number" ? event.total : current.total,
          bytes: typeof event.processed === "number" ? event.processed : current.bytes,
          status: event.kind === "completed" ? "completed" :
            event.kind === "skipped" ? "skipped" :
            event.kind === "skip-requested" ? "skipping" : "running",
        };
        return { ...previous, [key]: { ...batch, files } };
      });
    });
    const offNativeProgress = listen("ssh:native-zmodem-progress", (event: {
      ref: Ref; batchId: string; processed: number; total: number;
    }) => {
      if (!event?.ref) return;
      const key = refKey(event.ref);
      setNativeBatches(previous => {
        const batch = previous[key];
        if (!batch || batch.id !== event.batchId || batch.status !== "running") return previous;
        return { ...previous, [key]: { ...batch, bytes: event.processed, total: event.total } };
      });
    });
    const offSftp = listen("sftp:transfer", (task: SFTPTask) => {
      if (!task?.id || !task.ref) return;
      setSftpJobs(previous => Object.fromEntries(
        mergeTransferHistory(Object.values(previous), [task]).map(item => [item.id, item]),
      ));
    });
    const offDisconnect = listen("ssh:disconnected", (ref: Ref) => {
      if (!ref) return;
      const prefix = refKey(ref) + ":";
      for (const key of finished.current) {
        if (key.startsWith(prefix)) finished.current.delete(key);
      }
      setTerminalJobs(previous => {
        const next = { ...previous };
        for (const key of Object.keys(next)) {
          if (key.startsWith(prefix)) delete next[key];
        }
        return next;
      });
    });
    return () => {
      offDetails(); offState(); offProgress(); offFinished(); offFile(); offNativeBatch(); offNativeFile(); offNativeProgress(); offSftp(); offDisconnect();
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
      setTerminalJobs(previous => {
        const ended = Object.entries(previous).filter(([, job]) =>
          job.status === "completed" || job.status === "cancelled");
        if (!ended.length) return previous;
        const next = { ...previous };
        for (const [key] of ended) {
          delete next[key];
          finished.current.delete(key);
        }
        return next;
      });
      setSftpJobs(previous => {
        const completed = Object.values(previous).filter(task => task.status === "completed");
        if (!completed.length) return previous;
        const next = { ...previous };
        for (const task of completed) delete next[task.id];
        return next;
      });
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const native = useMemo(() => Object.entries(nativeBatches)
    .filter(([key]) => liveRefs.some(ref => refKey(ref) === key))
    .map(([key, batch]) => ({ key, batch })), [nativeBatches, refIDs]);
  const terminal = useMemo(() => Object.entries(terminalJobs)
    .filter(([key]) => liveRefs.some(ref => key.startsWith(refKey(ref) + ":")) &&
      !nativeBatches[refKey(terminalJobs[key].ref)])
    .map(([key, job]) => ({ key, job })), [terminalJobs, nativeBatches, refIDs]);
  const sftp = useMemo(() => Object.values(sftpJobs)
    .filter(task => liveRefs.some(ref => refKey(ref) === refKey(task.ref)))
    .sort((a, b) => b.created - a.created), [sftpJobs, refIDs]);
  const running = terminal.filter(({ job }) => job.status === "running" ||
    job.status === "cancelling").length + native.filter(({ batch }) =>
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
    setNativeBatches(previous => previous[key] ? ({
      ...previous, [key]: { ...previous[key], status: "cancelling" },
    }) : previous);
    void api.CancelNativeZmodemInteractiveTransfer(batch.ref).catch(error => {
      setNativeBatches(previous => previous[key] ? ({
        ...previous, [key]: { ...previous[key], status: "running" },
      }) : previous);
      onNotice(error);
    });
  };

  const cancelTerminal = (key: string, job: TerminalTransfer) => {
    setTerminalJobs(previous => ({ ...previous, [key]: { ...job, status: "cancelling" } }));
    void api.CancelZmodem(job.ref).catch(error => {
      setTerminalJobs(previous => previous[key] ? ({
        ...previous, [key]: { ...previous[key], status: "running" },
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
            {terminal.length === 0 && native.length === 0 && visibleSftp.length === 0 && (
              <p className="transfer-center-empty">{t("sftp:noTransfers")}</p>
            )}
            {native.map(({ key, batch }) => {
              const activeFiles = batch.files.filter(file => file.status !== "skipped");
              const sizesKnown = activeFiles.length > 0 && activeFiles.every(file => file.total != null);
              const total = sizesKnown ? activeFiles.reduce((sum, file) => sum + (file.total ?? 0), 0) : null;
              const bytes = activeFiles.reduce((sum, file) => sum + file.bytes, 0);
              const percent = total === null ? null : total === 0
                ? (batch.status === "completed" ? 100 : 0)
                : Math.min(100, Math.round(bytes / total * 100));
              return (
                <article key={"native-" + key} className="transfer-center-job">
                  <div className="transfer-center-line">
                    {batch.direction === "download" ? <ArrowDownToLine size={15}/> : <ArrowUpFromLine size={15}/>}
                    <strong>ZMODEM · {batch.files.length} 个文件</strong>
                    <span className="transfer-center-session" title={sessionName(batch.ref)}>{sessionName(batch.ref)}</span>
                    {batch.status === "running" || batch.status === "cancelling" ?
                      <button type="button" disabled={batch.status === "cancelling"}
                        title={t("sftp:cancelTransfer")} onClick={() => cancelNative(key, batch)}><X size={14}/></button> :
                      <Check size={15}/>}
                  </div>
                  {batch.files.map((file, index) => {
                    const filePercent = file.total == null ? null : file.total === 0
                      ? (file.status === "completed" ? 100 : 0)
                      : Math.min(100, Math.round(file.bytes / file.total * 100));
                    return (
                      <div className="transfer-center-native-file" key={batch.id + ":" + index}>
                        <div className="transfer-center-line">
                          <strong title={file.name}>{file.name}</strong>
                          <span className="transfer-center-session">{file.status === "queued" ? t("sftp:queued") :
                            file.status === "running" ? t("sftp:running") :
                            file.status === "skipping" ? t("sftp:zmodemSkipping") :
                            file.status === "skipped" ? t("sftp:zmodemSkipped") :
                            file.status === "completed" ? t("sftp:completed") :
                            file.status === "failed" ? t("sftp:failed") : t("sftp:cancelled")}</span>
                          {batch.status === "running" && file.status === "queued" && index > 0 &&
                            <button type="button" aria-label={t("sftp:zmodemSkipFile", { name: file.name })}
                              title={t("sftp:zmodemSkipFile", { name: file.name })}
                              onClick={() => void api.SkipNativeZmodemPendingFile(batch.ref, batch.id, index).catch(onNotice)}>
                              <X size={13}/>
                            </button>}
                        </div>
                        <div className={"transfer-center-bar" + (filePercent == null && file.status === "running" ? " indeterminate" : "")}
                          role="progressbar" aria-valuemin={0} aria-valuemax={filePercent == null ? undefined : 100}
                          aria-valuenow={filePercent == null ? undefined : filePercent}>
                          <div style={filePercent == null ? undefined : { width: String(filePercent) + "%" }}/>
                        </div>
                        <div className="transfer-center-metrics">
                          <span>{formatSize(file.bytes)} / {file.total == null ? t("sftp:transferUnknownProgress") : formatSize(file.total)}</span>
                          <span>{filePercent == null ? "—" : String(filePercent) + "%"}</span>
                        </div>
                      </div>
                    );
                  })}
                  <div className={"transfer-center-bar" + (percent == null && batch.status === "running" ? " indeterminate" : "")}
                    role="progressbar" aria-valuemin={0} aria-valuemax={percent == null ? undefined : 100}
                    aria-valuenow={percent == null ? undefined : percent}>
                    <div style={percent == null ? undefined : { width: String(percent) + "%" }}/>
                  </div>
                  <div className="transfer-center-metrics">
                    <span>{formatSize(bytes)} / {total == null ? t("sftp:transferUnknownProgress") : formatSize(total)}</span>
                    <span title={batch.error}>{batch.status === "failed" ? t("sftp:failed") :
                      percent == null ? t("sftp:transferUnknownProgress") : String(percent) + "%"}</span>
                  </div>
                </article>
              );
            })}
            {terminal.map(({ key, job }) => {
              const sizesKnown = job.files.length > 0 && job.files.every(file => file.total != null);
              const total = sizesKnown ? job.files.reduce((sum, file) => sum + (file.total ?? 0), 0) : null;
              const percent = job.status === "completed" ? 100 :
                total != null && total > 0 && typeof job.processed === "number"
                  ? Math.min(100, Math.round(job.processed / total * 100))
                  : job.percent ?? (total === 0 && sizesKnown ? 0 : null);
              const active = job.status === "running" || job.status === "cancelling";
              const statusLabel = job.status === "completed" ? t("sftp:completed") :
                job.status === "failed" ? t("sftp:failed") :
                job.status === "cancelled" ? t("sftp:cancelled") : t("sftp:running");
              const progressText = job.status === "completed" && total != null
                ? `${formatSize(total)} / ${formatSize(total)}`
                : total != null ? `${formatSize(job.processed ?? 0)} / ${formatSize(total)}`
                  : job.transferred ?? (active ? t("sftp:estimating") : "—");
              const metricStatus = job.status === "completed" ? t("sftp:completed") :
                job.status === "failed" ? t("sftp:failed") :
                job.status === "cancelled" ? t("sftp:cancelled") :
                percent == null ? statusLabel : `${percent}%`;
              return (
                <article key={key} className="transfer-center-job">
                  <div className="transfer-center-line">
                    {job.direction === "download" ? <ArrowDownToLine size={15} /> : <ArrowUpFromLine size={15} />}
                    <strong>{job.protocol === "trzsz" ? "trzsz" : "ZMODEM"}{job.files.length > 1 ? ` · ${job.files.length} 个文件` : ""}</strong>
                    <span className="transfer-center-session" title={sessionName(job.ref)}>{sessionName(job.ref)}</span>
                    {active ?
                      <button type="button" disabled={job.status === "cancelling"}
                        title={t("sftp:cancelTransfer")} onClick={() => cancelTerminal(key, job)}><X size={14} /></button> :
                      <Check size={15} />}
                  </div>
                  {job.files.length > 0 && (
                    <div className="transfer-center-terminal-files">
                      {job.files.slice(0, 4).map((file, index) => (
                        <div key={job.transferId + ":" + index} className="transfer-center-terminal-file">
                          <span title={file.name}>{file.name}</span>
                          <span>{file.total == null ? "—" : formatSize(file.total)}</span>
                        </div>
                      ))}
                      {job.files.length > 4 && <span className="transfer-center-terminal-more">+{job.files.length - 4} 个文件</span>}
                    </div>
                  )}
                  <div className={"transfer-center-bar" + (active && percent == null ? " indeterminate" : "")}
                    role="progressbar" aria-valuemin={0} aria-valuemax={percent == null ? undefined : 100}
                    aria-valuenow={percent == null ? undefined : percent}>
                    <div style={percent == null ? undefined : { width: String(percent) + "%" }} />
                  </div>
                  <div className="transfer-center-metrics">
                    <span>{progressText}{job.speed && active ? ` · ${job.speed}` : ""}</span>
                    <span title={job.error}>{metricStatus}</span>
                  </div>
                  {job.error && <div className="transfer-center-terminal-error" title={job.error}>{job.error}</div>}
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
