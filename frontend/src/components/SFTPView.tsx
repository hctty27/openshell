import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState, type MouseEvent, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, ArrowUpFromLine, FolderOpen, ChevronUp, ClipboardCopy, File, Folder, FolderPlus, RefreshCw, Info, Eye, EyeOff, Pencil, Trash2, Shield, X, CheckCircle2, CircleAlert, LoaderCircle, FileText, RotateCcw, ArrowLeftRight } from "lucide-react";
import { api, listen, errorText } from "../bridge";
import type { Ref, SFTPEntry, SFTPTask, SFTPDocument, SFTPTransferRequest } from "../types";
import { mergeTransferHistory, sameTransferRef } from "../features/transfers/transferHistory";
import { CoalescedTaskUpdates } from "../features/performance/coalescedTaskUpdates";
import { useDialogs } from "./DialogProvider";
import FloatingContextMenu, { type ContextMenuAction } from "./FloatingContextMenu";
import ModalSurface from "./ModalSurface";
import { i18n, t } from "../i18n";
import { Clipboard } from "@wailsio/runtime";
import { BASH_CWD_REPORT_COMMAND } from "../terminalCwd";
const SFTPFileEditor = lazy(() => import("./editor/SFTPFileEditor"));

type Side = "local" | "remote";
const directoryCacheKey = (ref: Ref, directory: string) =>
  [ref.tabId, ref.sessionId, ref.generation, directory].join("\u0000");
type Operation = "rename" | "delete" | "chmod" | "mkdir";
type SelectionMode = "single" | "toggle" | "range";
type DeleteProgress = { completed: number; total: number; failed: number; running: boolean; cancelled: boolean };
interface MarqueeState {
  pointerId: number;
  startX: number;
  startY: number;
  additive: boolean;
  active: boolean;
}
interface MarqueeRect { left: number; top: number; width: number; height: number }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const basename = (name: string) => name.split(/[\\/]/).filter(Boolean).pop() ?? name;
const join = (side: Side, dir: string, name: string) =>
  dir.replace(/[\\/]$/, "") + (side === "remote" ? "/" : (dir.includes("\\") ? "\\" : "/")) + name;
const parent = (side: Side, directory: string) => {
  if (side === "remote") {
    const normalized = directory.replace(/\/+$/, "");
    return normalized.slice(0, normalized.lastIndexOf("/")) || "/";
  }
  const normalized = directory.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index < 0 ? directory : normalized.slice(0, index + 1) || directory;
};
const niceSize = (value: number) => {
  if (value < 1024) return `${value} B`;
  const units = ["KB","MB","GB","TB"];
  let num = value, idx = -1;
  do { num /= 1024; idx++; } while(num >= 1024 && idx < units.length-1);
  return `${num.toFixed(num < 10 ? 1 : 0)} ${units[idx]}`;
};
interface Props { refID: Ref; onNotice(error: unknown): void; hideTaskQueue?: boolean; onRemoteDirectoryChange?(directory: string): void; initialRemoteDirectory?: string; cwdReported?: boolean; }
interface PanelProps {
  side: Side; directory: string; entries: SFTPEntry[]; selected: string[]; loading: boolean; error: unknown; showHidden: boolean;
  onToggleHidden(): void; onChooseDirectory?(): void; onDir(directory: string): void; onReload(): void;
  onSelect(item: SFTPEntry, mode: SelectionMode): void; onSelectAll(paths: string[]): void; onMarqueeSelect(paths: string[], additive: boolean): void; onClearSelection(): void;
  deleting: DeleteProgress | null; onCancelDelete(): void;
  onOpenFile?(entry:SFTPEntry): void; onTransfer(): void; onOperate(operation: Operation): void;
  onContext(event: MouseEvent<HTMLButtonElement>, entry: SFTPEntry): void; onFileDrop(event: DragEvent<HTMLElement>): void;
  onCwdHelp?(): void;
}
interface FileRowProps {
  entry: SFTPEntry;
  size: string;
  modified: string;
  selected: boolean;
  deleting: boolean;
  side: Side;
  callbacks: { current: PanelProps };
}

// A selection change only renders rows whose selection state actually changed.
const FileRow = memo(function FileRow({
  entry, size, modified, selected, deleting, side, callbacks,
}: FileRowProps) {
  return (
    <button type="button" role="listitem"
      className={"sftp-file-row" + (selected ? " selected" : "")} data-path={entry.path}
      draggable={!entry.isSymlink && !deleting}
      onDragStart={event => {
        const paths = callbacks.current.selected.includes(entry.path)
          ? callbacks.current.selected
          : [entry.path];
        event.dataTransfer.setData("application/x-openshell-entry", JSON.stringify({ side, path: entry.path, paths }));
        event.dataTransfer.effectAllowed = "copy";
      }}
      onClick={event => callbacks.current.onSelect(entry, event.shiftKey ? "range" : event.ctrlKey || event.metaKey ? "toggle" : "single")}
      onDoubleClick={() => {
        if (entry.isSymlink) return;
        if (entry.isDir) callbacks.current.onDir(entry.path);
        else callbacks.current.onOpenFile?.(entry);
      }}
      onContextMenu={event => callbacks.current.onContext(event, entry)}>
      <span className="sftp-file-name">{entry.isDir ? <Folder size={15}/> : <File size={15}/>}<span title={entry.path}>{entry.name}</span>{entry.isSymlink && <span className="sftp-link-badge">↗</span>}</span>
      <span>{size}</span>
      <span>{modified}</span><span>{entry.mode}</span>
    </button>
  );
});

function FilePanel(p: PanelProps) {
  const visible = useMemo(() => p.showHidden ? p.entries : p.entries.filter(e => !e.name.startsWith(".")), [p.entries,p.showHidden]);
  const [draft,setDraft] = useState(p.directory);
  useEffect(() => setDraft(p.directory),[p.directory]);
  const remote = p.side === "remote";
  const callbacks = useRef(p);
  callbacks.current = p;
  const selectedPaths = useMemo(() => new Set(p.selected), [p.selected]);
  const locale = i18n.language === "zh-CN" ? "zh-CN" : "en-US";
  const displayEntries = useMemo(() => visible.map(entry => ({
    entry,
    size: entry.isDir ? "—" : niceSize(entry.size),
    modified: new Date(entry.modified).toLocaleDateString(locale),
  })), [visible, locale]);
  const deleting = Boolean(p.deleting?.running);
  // Build only lightweight row elements when selection changes. Memoized
  // rows skip their render work unless their own selection or metadata changes.
  // Callbacks stay current through a stable ref.
  const fileRows = useMemo(() => displayEntries.map(({ entry, size, modified }) => (
    <FileRow key={entry.path} entry={entry} size={size} modified={modified}
      selected={selectedPaths.has(entry.path)} deleting={deleting}
      side={p.side} callbacks={callbacks} />
  )), [displayEntries, selectedPaths, p.side, deleting]);
  const tableRef = useRef<HTMLDivElement>(null);
  const marqueeRef = useRef<MarqueeState | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null);

  const updateMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = marqueeRef.current;
    const table = tableRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !table) return;

    const bounds = table.getBoundingClientRect();
    const x = clamp(event.clientX, bounds.left, bounds.right);
    const y = clamp(event.clientY, bounds.top, bounds.bottom);
    if (!drag.active && Math.hypot(x - drag.startX, y - drag.startY) < 4) return;

    drag.active = true;
    setMarqueeRect({
      left: Math.min(drag.startX, x) - bounds.left + table.scrollLeft,
      top: Math.min(drag.startY, y) - bounds.top + table.scrollTop,
      width: Math.abs(x - drag.startX),
      height: Math.abs(y - drag.startY),
    });

    const rows = table.querySelectorAll<HTMLButtonElement>(".sftp-file-row");
    if (rows.length === 0) {
      p.onMarqueeSelect([], drag.additive);
      return;
    }
    const first = rows[0].getBoundingClientRect();
    const last = rows[rows.length - 1].getBoundingClientRect();
    const top = Math.min(drag.startY, y);
    const bottom = Math.max(drag.startY, y);
    if (bottom < first.top || top > last.bottom) {
      p.onMarqueeSelect([], drag.additive);
      return;
    }

    const rowHeight = first.height || 29;
    const start = clamp(Math.floor((top - first.top) / rowHeight), 0, rows.length - 1);
    const end = clamp(Math.floor((bottom - first.top) / rowHeight), 0, rows.length - 1);
    const paths = Array.from(rows).slice(start, end + 1)
      .map(row => row.dataset.path)
      .filter((path): path is string => Boolean(path));
    p.onMarqueeSelect(paths, drag.additive);
  };

  const startMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.pointerType && event.pointerType !== "mouse")) return;
    const target = event.target as Element;
    if (target.closest(".sftp-file-row")) return;
    if (target !== event.currentTarget &&
        !target.closest(".sftp-column-head") &&
        !target.closest(".sftp-placeholder")) return;

    const table = event.currentTarget;
    marqueeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      additive: event.ctrlKey || event.metaKey,
      active: false,
    };
    try {
      table.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable in some test and embedded environments.
    }
    event.preventDefault();
  };

  const finishMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = marqueeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.active) updateMarquee(event);
    else if (!drag.additive) p.onClearSelection();
    marqueeRef.current = null;
    setMarqueeRect(null);
  };

  const cancelMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (marqueeRef.current?.pointerId !== event.pointerId) return;
    marqueeRef.current = null;
    setMarqueeRect(null);
  };

  return (
    <section className={`sftp-panel sftp-${p.side}`} onDragOver={event=>{
      if (event.dataTransfer.types.includes("application/x-openshell-entry")) event.preventDefault();
    }} onDrop={p.onFileDrop}>
      <div className="sftp-panel-header workspace-panel-header">
        <strong className="panel-header-title"><span className="workspace-panel-dot" aria-hidden="true" />{t(remote ? "sftp:remote" : "sftp:local")}</strong>
        <div className="sftp-actions panel-header-actions">
          {p.onChooseDirectory && <button title={t("sftp:chooseFolder")} onClick={p.onChooseDirectory}><FolderOpen size={14}/></button>}
          {p.onCwdHelp && <button type="button" aria-label={t("sftp:enableCwdReporting")} title={t("sftp:cwdNotReportedHelp")} onClick={p.onCwdHelp}><Info size={14}/></button>}
          <button title={t("sftp:chmod")} disabled={p.selected.length===0} onClick={()=>p.onOperate("chmod")}><Shield size={14}/></button>
          <button title={t("sftp:newFolder")} onClick={() => p.onOperate("mkdir")}><FolderPlus size={14}/></button>
          <button title={t("sftp:delete")} aria-label={t("sftp:delete")} disabled={!p.selected.length || Boolean(p.deleting?.running)} onClick={() => p.onOperate("delete")}><Trash2 size={14}/></button>
          <button title={t(p.showHidden ? "sftp:hideHidden" : "sftp:showHidden")} onClick={p.onToggleHidden}>{p.showHidden ? <EyeOff size={14}/> : <Eye size={14}/>}</button>
          <button title={t("sftp:refresh")} onClick={p.onReload}><RefreshCw size={14}/></button>
          {p.loading && p.entries.length > 0 && <LoaderCircle size={13} className="spin" aria-label={t("sftp:loading")}/>} 
        </div>
      </div>
      <form className="sftp-breadcrumb" onSubmit={event=>{event.preventDefault();p.onDir(draft);}}>
        <button type="button" title={t("sftp:up")} onClick={()=>p.onDir(parent(p.side,p.directory))}><ChevronUp size={15}/></button>
        <input aria-label={t("sftp:path")} value={draft} onChange={event=>setDraft(event.target.value)} spellCheck={false}/>
      </form>
      <div ref={tableRef} className={"sftp-file-table" + (marqueeRect ? " is-selecting" : "")}
        role="list" tabIndex={0} title={t("sftp:dragSelectionHint")}
        aria-label={t(remote ? "sftp:remote" : "sftp:local")}
        onPointerDown={startMarquee}
        onPointerMove={updateMarquee}
        onPointerUp={finishMarquee}
        onPointerCancel={cancelMarquee}
        onLostPointerCapture={cancelMarquee}
        onKeyDown={event => {
          if (event.altKey || event.nativeEvent.isComposing) return;
          if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "a") {
            event.preventDefault();
            p.onSelectAll(visible.map(item => item.path));
          } else if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "Escape") {
            event.preventDefault();
            p.onClearSelection();
          } else if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "Delete" && p.selected.length && !p.deleting?.running) {
            event.preventDefault();
            p.onOperate("delete");
          }
        }}>
        <div className="sftp-column-head"><span>{t("sftp:name")}</span><span>{t("sftp:size")}</span><span>{t("sftp:modified")}</span><span>{t("sftp:mode")}</span></div>
        {p.loading && p.entries.length === 0 ? <div className="sftp-placeholder"><LoaderCircle className="spin" size={17}/>{t("sftp:loading")}</div>
        : p.error ? <div className="sftp-placeholder sftp-error">{errorText(p.error)}</div>
        : visible.length === 0 ? <div className="sftp-placeholder">{t("sftp:emptyFolder")}</div>
        : fileRows}
        {marqueeRect && <div className="sftp-marquee" aria-hidden="true" style={{
          left: marqueeRect.left, top: marqueeRect.top,
          width: marqueeRect.width, height: marqueeRect.height,
        }}/>}
      </div>
      <div className="sftp-panel-footer">
        <span title={p.deleting ? t(p.deleting.cancelled ? "sftp:deleteCancelled" : p.deleting.running ? "sftp:deleteProgress" : "sftp:deleteComplete", { completed: p.deleting.completed, total: p.deleting.total, success: p.deleting.completed - p.deleting.failed, failed: p.deleting.failed }) : undefined}>
          {p.deleting ? t(p.deleting.cancelled ? "sftp:deleteCancelled" : p.deleting.running ? "sftp:deleteProgress" : "sftp:deleteComplete", { completed: p.deleting.completed, total: p.deleting.total, success: p.deleting.completed - p.deleting.failed, failed: p.deleting.failed })
            : p.selected.length ? t("sftp:selectedCount", { count: p.selected.length }) : t("sftp:fileCount", { count: visible.length })}
        </span>
        {p.deleting?.running && <button className="sftp-cancel-delete" title={t("sftp:cancelDelete")} onClick={p.onCancelDelete}><X size={13}/></button>}
        <button className="sftp-primary" disabled={!p.selected.length || Boolean(p.deleting?.running)} onClick={p.onTransfer}>
          {remote ? <ArrowDownToLine size={13}/> : <ArrowUpFromLine size={13}/>}
          {t(remote ? "sftp:download" : "sftp:upload")}
        </button>
      </div>
    </section>
  );
}
export default function SFTPView({refID,onNotice,hideTaskQueue = false,onRemoteDirectoryChange,initialRemoteDirectory,cwdReported = false}:Props) {
  useTranslation();
  const dialogs = useDialogs();
  const [localDir,setLocalDir] = useState("");
  const navigatedLocalDir = useRef("");
  const [remoteDir,setRemoteDir] = useState("");
  const [localFiles,setLocalFiles] = useState<SFTPEntry[]>([]);
  const [remoteFiles,setRemoteFiles] = useState<SFTPEntry[]>([]);
  const [localBusy,setLocalBusy] = useState(false);
  const [remoteBusy,setRemoteBusy] = useState(false);
  const [localError,setLocalError] = useState<unknown>("");
  const [remoteError,setRemoteError] = useState<unknown>("");
  const [selection,setSelection] = useState<Record<Side,string[]>>({local:[],remote:[]});
  const selectionAnchor = useRef<Record<Side,string|null>>({local:null,remote:null});
  const [deleting,setDeleting] = useState<Record<Side,DeleteProgress|null>>({local:null,remote:null});
  const deletionRunning = useRef<Record<Side,boolean>>({local:false,remote:false});
  const deletionCancelled = useRef<Record<Side,boolean>>({local:false,remote:false});
  const [hidden,setHidden] = useState<Record<Side, boolean>>({local:false,remote:false});
  const [versions,setVersions] = useState<Record<Side, number>>({local:0,remote:0});
  const [localListedKey,setLocalListedKey] = useState("");
  const [remoteListedKey,setRemoteListedKey] = useState("");
  const refresh = (side:Side) => setVersions(current => ({...current,[side]:current[side]+1}));
  const [tasks,setTasks] = useState<SFTPTask[]>([]);
  const [queueOpen,setQueueOpen] = useState(true);
  const [editor,setEditor] = useState<SFTPDocument|null>(null);
  const [editorLoadingPath,setEditorLoadingPath] = useState<string|null>(null);
  const [editorLoadError,setEditorLoadError] = useState<string|null>(null);
  const editorRequestID = useRef(0);
  const editorReadRequest = useRef<string|null>(null);
  const editorLoadInProgress = useRef(false);
  const [draftText,setDraftText] = useState("");
  const [editorSaving,setEditorSaving] = useState(false);
  const editorSaveInProgress = useRef(false);
  const [syncBusy,setSyncBusy] = useState(false);
  const [menu,setMenu] = useState<{x:number;y:number;anchor:HTMLElement;items:ContextMenuAction[]}|null>(null);

  useEffect(() => {
    let alive=true;
    editorRequestID.current++;
    editorLoadInProgress.current=false;
    setEditorLoadingPath(null);
    setEditorLoadError(null);
    setEditor(null);
    setDraftText("");
    setTasks([]);
    navigatedLocalDir.current = "";
    api.SFTPHome(refID).then(async paths => {
      if (!alive) return;
      setLocalDir(paths.local);
      const preferred = initialRemoteDirectory?.startsWith("/") ? initialRemoteDirectory : "";
      if (!preferred || preferred === paths.remote) {
        setRemoteDir(paths.remote);
        return;
      }
      // Confirm cwd exists before opening; a deleted/inaccessible directory
      // must fall back to the SFTP home instead of trapping the file browser.
      try {
        await api.SFTPList(refID, "remote", preferred);
        if (alive) setRemoteDir(preferred);
      } catch {
        if (alive) setRemoteDir(paths.remote);
      }
    }).catch(error => { if(alive) onNotice(error); });
    api.SFTPTransfers(refID).then(list=>{
      if(alive)setTasks(current => mergeTransferHistory(list??[],current.filter(task => sameTransferRef(task.ref, refID))));
    }).catch(()=>{});
    return ()=>{
      alive=false;
      const active = editorReadRequest.current;
      if (active) {
        editorReadRequest.current=null;
        void api.SFTPCancelReadRemoteText(active).catch(()=>{});
      }
    };
  },[refID.tabId,refID.sessionId,refID.generation]);
  useEffect(()=>{
    if(!localDir)return;
    let alive=true;setLocalBusy(true);setLocalError("");
    api.SFTPList(refID,"local",localDir).then(items=>{if(alive){
      setLocalFiles(items??[]);
      setLocalListedKey(directoryCacheKey(refID,localDir));
      if (navigatedLocalDir.current === localDir) {
        navigatedLocalDir.current = "";
        void api.SaveTransferLocalDir(refID.sessionId,localDir).catch(onNotice);
      }
    }})
      .catch(error=>{if(alive){setLocalFiles([]);setLocalError(error);}})
      .finally(()=>{if(alive)setLocalBusy(false);});
    return ()=>{alive=false;};
  },[refID.tabId,refID.sessionId,refID.generation,localDir,versions.local]);
  useEffect(()=>{
    if(!remoteDir)return;
    let alive=true;setRemoteBusy(true);setRemoteError("");
    api.SFTPList(refID,"remote",remoteDir).then(items=>{if(alive){setRemoteFiles(items??[]);setRemoteListedKey(directoryCacheKey(refID,remoteDir));}})
      .catch(error=>{if(alive){setRemoteFiles([]);setRemoteError(error);}})
      .finally(()=>{if(alive)setRemoteBusy(false);});
    return ()=>{alive=false;};
  },[refID.tabId,refID.sessionId,refID.generation,remoteDir,versions.remote]);
  useEffect(()=>{
    const updates = new CoalescedTaskUpdates<SFTPTask>(batch =>
      setTasks(old => mergeTransferHistory(old, batch)));
    const off=listen("sftp:transfer",(task:SFTPTask)=>{
      if(!sameTransferRef(task?.ref, refID))return;
      // Running progress is visual-only; queue and terminal states remain immediate.
      updates.enqueue(task, task.status !== "running");
      if(task.status==="completed")refresh(task.direction==="upload"?"remote":"local");
    });
    return ()=>{off();updates.dispose();};
  },[refID.tabId,refID.sessionId,refID.generation]);

  const transfer = async (side:Side, paths:string[], dstDir:string) => {
    if (!dstDir || paths.length === 0) return;
    const direction = side === "local" ? "upload" : "download";
    const destSide = side === "local" ? "remote" : "local";
    try {
      const destinationNames = new Set(
        (await api.SFTPList(refID, destSide, dstDir)).map(item => item.name),
      );
      const conflicts = paths.filter(path => destinationNames.has(basename(path)));
      const conflictPreview = [
        ...conflicts.slice(0, 30).map(basename),
        ...(conflicts.length > 30 ? [t("sftp:moreSelected", { count: conflicts.length - 30 })] : []),
      ].join("\n");
      const requests: SFTPTransferRequest[] = [];
      let overwriteAll = false;
      let skipAll = false;
      let conflictPosition = 0;

      for (const file of paths) {
        const name = basename(file);
        const existing = destinationNames.has(name);
        let overwrite = false;
        if (existing) {
          conflictPosition++;
          if (skipAll) continue;
          if (overwriteAll) {
            overwrite = true;
          } else {
            const choice = await dialogs.choose({
              title: t("sftp:overwriteTitle"),
              description: t("sftp:overwriteBatchDescription", {
                name, current: conflictPosition, total: conflicts.length,
              }),
              tone: "warning",
              preview: conflicts.length > 1 ? conflictPreview : undefined,
              cancelLabel: t("sftp:cancelTransferBatch"),
              choices: [
                { value: "overwrite", label: t("sftp:overwriteCurrent") },
                { value: "overwrite-all", label: t("sftp:overwriteAll"), tone: "primary" },
                { value: "skip", label: t("sftp:skipCurrent") },
                { value: "skip-all", label: t("sftp:skipAll") },
              ],
            });
            if (choice === null) return;
            if (choice === "overwrite") overwrite = true;
            else if (choice === "overwrite-all") {
              overwrite = true;
              overwriteAll = true;
            } else if (choice === "skip-all") {
              skipAll = true;
              continue;
            } else if (choice === "skip") {
              continue;
            } else {
              return;
            }
          }
        }
        requests.push({
          direction, source: file, destination: join(destSide, dstDir, name),
          overwrite, resume: true,
        });
        destinationNames.add(name);
      }
      if (requests.length) await api.SFTPStartBatch(refID, requests);
    } catch (error) {
      onNotice(error);
    }
  };
  useEffect(() => {
    if (remoteDir) onRemoteDirectoryChange?.(remoteDir);
  }, [remoteDir, refID.tabId, refID.generation]);

  const changeDir = (side:Side, directory:string) => {
    if(!directory)return;
    if(side==="local"){
      navigatedLocalDir.current = directory;
      setLocalDir(directory);
    } else setRemoteDir(directory);
    selectionAnchor.current[side] = null;
    setSelection(s=>({...s,[side]:[]}));
    setDeleting(s=>({...s,[side]:null}));
  };
  const choose = (side:Side,item:SFTPEntry,mode:SelectionMode) => {
    // Only Shift-range selection needs to scan the directory. Ordinary
    // clicks and Ctrl-clicks should not iterate thousands of entries.
    const entries = mode==="range"
      ? (side==="local" ? localFiles : remoteFiles).filter(file => hidden[side] || !file.name.startsWith("."))
      : null;
    const anchorIndex = entries?.findIndex(file => file.path === selectionAnchor.current[side]) ?? -1;
    const targetIndex = entries?.findIndex(file => file.path === item.path) ?? -1;
    if (mode !== "range") selectionAnchor.current[side] = item.path;
    setSelection(s=>{
      const previous=s[side];
      if (entries && anchorIndex>=0 && targetIndex>=0) {
        const start=Math.min(anchorIndex,targetIndex), end=Math.max(anchorIndex,targetIndex);
        return {...s,[side]:entries.slice(start,end+1).map(file=>file.path)};
      }
      return {...s,[side]:mode==="toggle" ? previous.includes(item.path) ? previous.filter(path=>path!==item.path) : [...previous,item.path] : [item.path]};
    });
    if (!deletionRunning.current[side]) setDeleting(s=>({...s,[side]:null}));
  };
  const selectAll = (side:Side,paths:string[]) => {
    selectionAnchor.current[side] = paths[0] ?? null;
    setSelection(s=>({...s,[side]:paths}));
    if (!deletionRunning.current[side]) setDeleting(s=>({...s,[side]:null}));
  };
  const selectMarquee = (side:Side, paths:string[], additive:boolean) => {
    if (paths.length && (!additive || !selectionAnchor.current[side])) {
      selectionAnchor.current[side] = paths[0];
    } else if (!additive && paths.length === 0) {
      selectionAnchor.current[side] = null;
    }
    setSelection(current => {
      const next = additive
        ? Array.from(new Set([...current[side], ...paths]))
        : paths;
      if (next.length === current[side].length &&
          next.every((path, index) => path === current[side][index])) return current;
      return { ...current, [side]: next };
    });
    if (!deletionRunning.current[side]) {
      setDeleting(current => current[side] === null ? current : { ...current, [side]: null });
    }
  };
  const clearSelection = (side:Side) => {
    selectionAnchor.current[side] = null;
    setSelection(s=>({...s,[side]:[]}));
    if (!deletionRunning.current[side]) setDeleting(s=>({...s,[side]:null}));
  };
  const operate = async (side:Side, operation:Operation, entries?:SFTPEntry[]) => {
    if (deletionRunning.current[side]) return;
    const files=side==="local" ? localFiles : remoteFiles;
    const dir=side==="local" ? localDir : remoteDir;
    const selected=entries ?? files.filter(f=>selection[side].includes(f.path) && (hidden[side] || !f.name.startsWith(".")));
    if(operation!=="mkdir"&&!selected.length)return;
    try {
      if(operation==="mkdir") {
        const name=await dialogs.input({title:t("sftp:newFolder"),label:t("sftp:newFolderName"),icon:"create"});
        if(name===null)return;
        if(!validName(name)){onNotice(t("sftp:invalidName"));return;}
        await api.SFTPOperate(refID,side,"mkdir",join(side,dir,name),"");
      } else if(operation==="delete") {
        const fileCount=selected.filter(file=>!file.isDir).length;
        const folderCount=selected.length-fileCount;
        const accepted=await dialogs.confirm({
          title:t("sftp:deleteTitle"),
          description:selected.length===1 ? t("sftp:deleteWarning",{name:selected[0].name}) : t("sftp:deleteWarningBatch",{files:fileCount,folders:folderCount}),
          preview:selected.length>1 ? [...selected.slice(0,20).map(file=>file.name+(file.isDir?"/":"")), ...(selected.length>20 ? [t("sftp:moreSelected",{count:selected.length-20})] : [])].join("\n") : undefined,
          tone:"danger",confirmLabel:t("sftp:delete")
        });
        if(!accepted)return;
        const latest=await api.SFTPList(refID,side,dir);
        const current=new Map(latest.map(file=>[file.path,file]));
        deletionRunning.current[side]=true;
        deletionCancelled.current[side]=false;
        let completed=0, failed=0;
        const failedPaths:string[]=[];
        const errorDetails:string[]=[];
        setDeleting(s=>({...s,[side]:{completed:0,total:selected.length,failed:0,running:true,cancelled:false}}));
        try {
          for(const file of selected) {
            if(deletionCancelled.current[side])break;
            try {
              const actual=current.get(file.path);
              if (!actual || actual.isDir!==file.isDir || actual.isSymlink!==file.isSymlink) {
                throw new Error(t("sftp:deleteStale"));
              }
              await api.SFTPOperate(refID,side,"delete",file.path,"");
            } catch(error) {
              failed++;
              failedPaths.push(file.path);
              errorDetails.push(file.name+": "+errorText(error));
            }
            completed++;
            setDeleting(s=>({...s,[side]:{completed,total:selected.length,failed,running:true,cancelled:false}}));
          }
        } finally {
          const cancelled=deletionCancelled.current[side];
          deletionRunning.current[side]=false;
          setDeleting(s=>({...s,[side]:{completed,total:selected.length,failed,running:false,cancelled}}));
          setSelection(s=>({...s,[side]:failedPaths}));
          selectionAnchor.current[side]=failedPaths[0] ?? null;
          refresh(side);
        }
        if(errorDetails.length)onNotice(t("sftp:deleteFailures",{count:errorDetails.length,details:errorDetails.slice(0,8).join("\n")}));
        return;
      } else if(operation==="rename") {
        if(selected.length!==1)return;
        const file=selected[0];
        const name=await dialogs.input({title:t("sftp:renameTitle"),label:t("sftp:renameName"),defaultValue:file.name,icon:"rename"});
        if(name===null||name===file.name)return;
        if(!validName(name)){onNotice(t("sftp:invalidName"));return;}
        await api.SFTPOperate(refID,side,"rename",file.path,join(side,dir,name));
      } else {
        const mode=await dialogs.input({title:t("sftp:chmodTitle"),label:t("sftp:permissions"),description:t("sftp:chmodDescription"),defaultValue:selected.length===1?selected[0].mode:"0644"});
        if(mode===null)return;
        if(!/^[0-7]{3,4}$/.test(mode)){onNotice(t("sftp:chmodDescription"));return;}
        if(selected.length>1 && !(await dialogs.confirm({title:t("sftp:batchPermissionsTitle"),description:t("sftp:batchPermissionsDescription",{count:selected.length}),confirmLabel:t("common:confirm")})))return;
        await api.SFTPBatchChmod(refID,side,selected.map(file=>file.path),mode);
      }
      refresh(side);
      setSelection(s=>({...s,[side]:[]}));
    }catch(error){onNotice(error);}
  };
  const context = (event:MouseEvent<HTMLButtonElement>,side:Side,item:SFTPEntry) => {
    event.preventDefault();
    const other = side==="local" ? remoteDir : localDir;
    const files=(side==="local" ? localFiles : remoteFiles).filter(file=>hidden[side] || !file.name.startsWith("."));
    const selected=selection[side].includes(item.path) ? files.filter(file=>selection[side].includes(file.path)) : [item];
    const items:ContextMenuAction[] = [
      {label:t(side==="local"?"sftp:upload":"sftp:download"),icon:side==="local"?ArrowUpFromLine:ArrowDownToLine,onSelect:()=>void transfer(side,selected.map(file=>file.path),other)},
      ...(selected.length===1 && side==="remote" && !item.isDir && !item.isSymlink ? [{label:t("sftp:editText"),icon:FileText,onSelect:()=>void openEditor(item)}] : []),
      ...(selected.length===1 ? [{label:t("sftp:rename"),icon:Pencil,onSelect:()=>void operate(side,"rename",selected)}] : []),
      {label:t("sftp:chmod"),icon:Shield,onSelect:()=>void operate(side,"chmod",selected)},
      ...(selected.length===1 ? [{label:t("sftp:copyPath"),icon:ClipboardCopy,onSelect:()=>void Clipboard.SetText(item.path).catch(onNotice)}] : []),
      {label:selected.length>1 ? t("sftp:deleteSelected",{count:selected.length}) : t("sftp:delete"),icon:Trash2,danger:true,separatorBefore:true,onSelect:()=>void operate(side,"delete",selected)}
    ];
    if(!selection[side].includes(item.path)) {
      selectionAnchor.current[side]=item.path;
      setSelection(s=>({...s,[side]:[item.path]}));
    }
    setMenu({x:event.clientX,y:event.clientY,anchor:event.currentTarget,items});
  };
  const drop = (target:Side,event:DragEvent<HTMLElement>) => {
    const raw = event.dataTransfer.getData("application/x-openshell-entry");
    if (!raw) return;
    event.preventDefault();
    try {
      const source = JSON.parse(raw) as { side:Side; path?:string; paths?:string[] };
      const paths = Array.isArray(source.paths)
        ? source.paths.filter((path): path is string => typeof path === "string" && path.length > 0)
        : source.path ? [source.path] : [];
      if (source.side !== target && paths.length) {
        void transfer(source.side, paths, target === "remote" ? remoteDir : localDir);
      }
    } catch {
      // Ignore unrelated drag payloads.
    }
  };
  const openEditor = async (entry:Pick<SFTPEntry,"path">) => {
    if(editorLoadInProgress.current || editor || editorSaveInProgress.current)return;
    const requestID=++editorRequestID.current;
    const requestKey=`sftp-read-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    editorReadRequest.current=requestKey;
    editorLoadInProgress.current=true;
    setEditorLoadingPath(entry.path);
    setEditorLoadError(null);
    let completed=false;
    try {
      const doc=await api.SFTPReadRemoteTextRequest(refID,entry.path,requestKey);
      if(requestID!==editorRequestID.current)return;
      completed=true;
      setEditor(doc);setDraftText(doc.content);
    }catch(error){
      if(requestID===editorRequestID.current)setEditorLoadError(errorText(error));
    }finally{
      if(requestID===editorRequestID.current){
        editorReadRequest.current=null;
        editorLoadInProgress.current=false;
        if(completed)setEditorLoadingPath(null);
      }
    }
  };
  const closeEditor = async () => {
    if(editorLoadingPath){
      const active = editorReadRequest.current;
      editorReadRequest.current=null;
      editorRequestID.current++;
      editorLoadInProgress.current=false;
      setEditorLoadingPath(null);
      setEditorLoadError(null);
      if(active)void api.SFTPCancelReadRemoteText(active).catch(()=>{});
      return;
    }
    if(editorSaveInProgress.current)return;
    if(editor && draftText!==editor.content){
      const ok=await dialogs.confirm({title:t("sftp:discardEditorTitle"),description:t("sftp:discardEditorDescription"),tone:"warning",confirmLabel:t("sftp:discard")});
      if(!ok)return;
    }
    setEditor(null);
  };
  const saveEditor = async (content:string) => {
    if(!editor || editorSaveInProgress.current || content===editor.content)return;
    editorSaveInProgress.current=true;
    setEditorSaving(true);
    try {
      const next=await api.SFTPSaveRemoteText(refID,editor.path,editor.revision,content);
      setEditor(next);
      setDraftText(current=>current===content?next.content:current);
      refresh("remote");
    }catch(error){onNotice(error);}
    finally{editorSaveInProgress.current=false;setEditorSaving(false);}
  };
  const sync = async (direction:"upload"|"download") => {
    if(syncBusy || !localDir || !remoteDir)return;
    setSyncBusy(true);
    try {
      const preview=await api.SFTPPreviewSync(refID,direction,localDir,remoteDir);
      const selected=preview.actions.filter(action=>action.operation==="copy");
      const conflicts=preview.actions.filter(action=>action.operation==="conflict");
      const lines=selected.slice(0,35).map(a=>`${a.reason==="missing"?"+":"~"} ${a.relative} (${niceSize(a.size)})`);
      if(conflicts.length)lines.push(String(conflicts.length)+" "+t("sftp:syncConflictsSkipped"));
      if(selected.length>35)lines.push("… "+String(selected.length-35)+" "+t("sftp:moreItems"));
      if(selected.length===0){onNotice(t("sftp:syncNoChanges"));return;}
      const ok=await dialogs.confirm({
        title:t(direction==="upload"?"sftp:syncUpload":"sftp:syncDownload"),
        description:t("sftp:syncPreviewDescription",{count:selected.length,skipped:preview.skipped+conflicts.length,size:niceSize(preview.bytes)}),
        preview:lines.join("\n"),tone:"warning",confirmLabel:t("sftp:syncApply")
      });
      if(!ok)return;
      const destSide=direction==="upload"?"remote":"local";
      const directories=new Set(selected.map(item=>parent(destSide,item.destination)));
      for(const directory of directories) {
        await api.SFTPEnsureDirectory(refID,destSide,directory);
      }
      await api.SFTPStartBatch(refID,selected.map(item=>({
        direction, source:item.source, destination:item.destination,
        overwrite:item.reason==="changed", resume:true,
      })));
      refresh(direction==="upload"?"remote":"local");
    }catch(error){onNotice(error);}
    finally{setSyncBusy(false);}
  };
  const retry = async (task:SFTPTask, resume:boolean) => {
    try {await api.SFTPTransfer(refID,task.direction,task.source,task.destination,task.overwrite,resume);}
    catch(error){onNotice(error);}
  };
  return (
    <div className="sftp-view">
      <div className="sftp-panes">
        <FilePanel side="local" directory={localDir} entries={localListedKey===directoryCacheKey(refID,localDir)?localFiles:[]} selected={selection.local} loading={localBusy} error={localError} showHidden={hidden.local}
          onToggleHidden={()=>{setHidden(s=>({...s,local:!s.local}));clearSelection("local");}} onChooseDirectory={()=>void api.SFTPChooseDirectory().then(dir=>{if(dir)changeDir("local",dir);}).catch(onNotice)} onDir={dir=>changeDir("local",dir)} onReload={()=>refresh("local")}
          onSelect={(item,mode)=>choose("local",item,mode)} onSelectAll={paths=>selectAll("local",paths)} onMarqueeSelect={(paths,additive)=>selectMarquee("local",paths,additive)} onClearSelection={()=>clearSelection("local")} deleting={deleting.local} onCancelDelete={()=>{deletionCancelled.current.local=true;}} onTransfer={()=>void transfer("local",selection.local,remoteDir)}
          onOperate={action=>void operate("local",action)} onContext={(event,item)=>context(event,"local",item)}
          onFileDrop={event=>drop("local",event)}/>
        <FilePanel side="remote" directory={remoteDir} entries={remoteListedKey===directoryCacheKey(refID,remoteDir)?remoteFiles:[]} selected={selection.remote} loading={remoteBusy} error={remoteError} showHidden={hidden.remote}
          onToggleHidden={()=>{setHidden(s=>({...s,remote:!s.remote}));clearSelection("remote");}} onDir={dir=>changeDir("remote",dir)} onReload={()=>refresh("remote")}
          onCwdHelp={!cwdReported ? () => void Clipboard.SetText(BASH_CWD_REPORT_COMMAND)
            .then(() => onNotice(t("sftp:cwdCommandCopied")))
            .catch(onNotice) : undefined}
          onOpenFile={item=>void openEditor(item)} onSelect={(item,mode)=>choose("remote",item,mode)} onSelectAll={paths=>selectAll("remote",paths)} onMarqueeSelect={(paths,additive)=>selectMarquee("remote",paths,additive)} onClearSelection={()=>clearSelection("remote")} deleting={deleting.remote} onCancelDelete={()=>{deletionCancelled.current.remote=true;}} onTransfer={()=>void transfer("remote",selection.remote,localDir)}
          onOperate={action=>void operate("remote",action)} onContext={(event,item)=>context(event,"remote",item)}
          onFileDrop={event=>drop("remote",event)}/>
      </div>
      <div className="sftp-sync-controls">
        <span title={t("sftp:syncFolders")}><ArrowLeftRight size={13}/><span className="sftp-sync-label">{t("sftp:path")}</span></span>
        <button type="button" title={t("sftp:syncUpload")} aria-label={t("sftp:syncUpload")} disabled={syncBusy} onClick={()=>void sync("upload")}>
          <ArrowUpFromLine size={13}/><span className="sftp-sync-label">{t("sftp:syncUploadShort")}</span>
        </button>
        <button type="button" title={t("sftp:syncDownload")} aria-label={t("sftp:syncDownload")} disabled={syncBusy} onClick={()=>void sync("download")}>
          <ArrowDownToLine size={13}/><span className="sftp-sync-label">{t("sftp:syncDownloadShort")}</span>
        </button>
      </div>
      {!hideTaskQueue && <div className={`sftp-queue ${queueOpen?"expanded":""}`}>
        <button className="sftp-queue-heading" onClick={()=>setQueueOpen(v=>!v)}>
          <span><ArrowUpFromLine size={13}/>{t("sftp:transferQueue")} ({tasks.length})</span><ChevronUp size={14}/>
        </button>
        {queueOpen && <div className="sftp-queue-list">
          {tasks.length===0?<span className="sftp-no-tasks">{t("sftp:noTransfers")}</span>:
          [...tasks].reverse().slice(0,40).map(task=>(
            <div className="sftp-task" key={task.id}>
              {task.status==="completed"? <CheckCircle2 size={14}/> : task.status==="failed"? <CircleAlert size={14}/> : task.direction==="upload"?<ArrowUpFromLine size={14}/>:<ArrowDownToLine size={14}/>}
              <span className="sftp-task-name" title={task.source}>{task.name}</span>
              <span className="sftp-task-state" title={task.error ? errorText(task.error) : undefined}>{task.error ? errorText(task.error) : t(`sftp:${task.status}` as "sftp:queued")}</span>
              <span className="sftp-task-size">{niceSize(task.bytes)} / {niceSize(task.total)}</span>
              <div className="sftp-progress"><span style={{width:`${task.total ? Math.min(100,task.bytes/task.total*100) : (task.status==="completed"?100:0)}%`}}/></div>
              {(task.status==="running"||task.status==="queued")&&<button title={t("sftp:cancelTransfer")} onClick={()=>void api.SFTPCancel(task.id).catch(onNotice)}><X size={13}/></button>}
              {(task.status==="failed"||task.status==="cancelled")&&<span className="sftp-retry-actions">
                <button title={t("sftp:resumeTransfer")} onClick={()=>void retry(task,true)}><RotateCcw size={13}/></button>
                <button title={t("sftp:restartTransfer")} onClick={()=>void retry(task,false)}><RefreshCw size={13}/></button>
              </span>}
            </div>
          ))}
        </div>}
      </div>}
      {(editor || editorLoadingPath) && (
        <ModalSurface
          className="sftp-editor-dialog"
          aria-label={t("sftp:editText")}
          onDismiss={()=>void closeEditor()}
          locked={editorSaving}
          closeOnBackdrop={false}
          onOpen={()=>document.querySelector<HTMLElement>(".sftp-editor-dialog .cm-content")?.focus()}
        >
          {editor ? <Suspense fallback={<div className="sftp-editor-loading"><LoaderCircle size={18} className="spin"/>{t("sftp:loading")}</div>}>
            <SFTPFileEditor
              key={refID.tabId + ":" + refID.generation + ":" + editor.path}
              path={editor.path}
              initialContent={editor.content}
              dirty={draftText!==editor.content}
              saving={editorSaving}
              onChange={setDraftText}
              onSave={content=>void saveEditor(content)}
              onClose={()=>void closeEditor()}
            />
          </Suspense> : <section className="sftp-editor">
            <header>
              <strong title={editorLoadingPath ?? ""}><FileText size={15}/><span>{editorLoadingPath}</span></strong>
              <div className="sftp-editor-tools">
                <button type="button" title={t("common:close")} aria-label={t("common:close")} onClick={()=>void closeEditor()}><X size={17}/></button>
              </div>
            </header>
            <div className="sftp-editor-pending" role="status">
              {editorLoadError ? <>
                <CircleAlert size={20} className="sftp-editor-error-icon"/>
                <strong>{t("sftp:editorLoadFailed")}</strong>
                <span className="sftp-editor-error-message">{editorLoadError}</span>
              </> : <>
                <LoaderCircle size={20} className="spin"/>
                <strong>{t("sftp:editorReading")}</strong>
                <span>{t("sftp:editorReadingHint")}</span>
              </>}
            </div>
            <footer>
              {editorLoadError && <button type="button" onClick={()=>{if(editorLoadingPath)void openEditor({path:editorLoadingPath});}}>{t("sftp:editorRetry")}</button>}
              <button type="button" onClick={()=>void closeEditor()}>{t("common:cancel")}</button>
            </footer>
          </section>}
        </ModalSurface>
      )}
      {menu && <FloatingContextMenu {...menu} onClose={()=>setMenu(null)}/>}
    </div>
  );
}
function validName(value:string){
  return Boolean(value && value!=="." && value!==".." && !/[\/\\\0]/.test(value));
}
