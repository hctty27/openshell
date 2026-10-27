import { useEffect, useMemo, useState, type MouseEvent, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, ArrowUpFromLine, FolderOpen, ChevronUp, ClipboardCopy, File, Folder, FolderPlus, RefreshCw, Info, Eye, EyeOff, Pencil, Trash2, Shield, X, CheckCircle2, CircleAlert, LoaderCircle, FileText, RotateCcw, Save, ArrowLeftRight } from "lucide-react";
import { api, listen, errorText } from "../bridge";
import type { Ref, SFTPEntry, SFTPTask, SFTPDocument } from "../types";
import { useDialogs } from "./DialogProvider";
import FloatingContextMenu, { type ContextMenuAction } from "./FloatingContextMenu";
import { i18n, t } from "../i18n";
import { ClipboardSetText } from "../../wailsjs/runtime/runtime";
import { BASH_CWD_REPORT_COMMAND } from "../terminalCwd";

type Side = "local" | "remote";
type Operation = "rename" | "delete" | "chmod" | "mkdir";
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
  onToggleHidden(): void; onChooseDirectory?(): void; onDir(directory: string): void; onReload(): void; onSelect(item: SFTPEntry, multi: boolean): void;
  onOpenFile?(entry:SFTPEntry): void; onTransfer(): void; onOperate(operation: Operation, entry?: SFTPEntry): void;
  onContext(event: MouseEvent<HTMLButtonElement>, entry: SFTPEntry): void; onFileDrop(event: DragEvent<HTMLElement>): void;
  onCwdHelp?(): void;
}
function FilePanel(p: PanelProps) {
  const visible = useMemo(() => p.showHidden ? p.entries : p.entries.filter(e => !e.name.startsWith(".")), [p.entries,p.showHidden]);
  const [draft,setDraft] = useState(p.directory);
  useEffect(() => setDraft(p.directory),[p.directory]);
  const remote = p.side === "remote";
  return (
    <section className={`sftp-panel sftp-${p.side}`} onDragOver={event=>{
      if (event.dataTransfer.types.includes("application/x-openshell-entry")) event.preventDefault();
    }} onDrop={p.onFileDrop}>
      <div className="sftp-panel-header">
        <strong><span className="sftp-panel-dot" />{t(remote ? "sftp:remote" : "sftp:local")}</strong>
        <div className="sftp-actions">
          {p.onChooseDirectory && <button title={t("sftp:chooseFolder")} onClick={p.onChooseDirectory}><FolderOpen size={14}/></button>}
          {p.onCwdHelp && <button type="button" aria-label={t("sftp:enableCwdReporting")} title={t("sftp:cwdNotReportedHelp")} onClick={p.onCwdHelp}><Info size={14}/></button>}
          <button title={t("sftp:chmod")} disabled={p.selected.length===0} onClick={()=>p.onOperate("chmod")}><Shield size={14}/></button>
          <button title={t("sftp:newFolder")} onClick={() => p.onOperate("mkdir")}><FolderPlus size={14}/></button>
          <button title={t(p.showHidden ? "sftp:hideHidden" : "sftp:showHidden")} onClick={p.onToggleHidden}>{p.showHidden ? <EyeOff size={14}/> : <Eye size={14}/>}</button>
          <button title={t("sftp:refresh")} onClick={p.onReload}><RefreshCw size={14}/></button>
        </div>
      </div>
      <form className="sftp-breadcrumb" onSubmit={event=>{event.preventDefault();p.onDir(draft);}}>
        <button type="button" title={t("sftp:up")} onClick={()=>p.onDir(parent(p.side,p.directory))}><ChevronUp size={15}/></button>
        <input aria-label={t("sftp:path")} value={draft} onChange={event=>setDraft(event.target.value)} spellCheck={false}/>
      </form>
      <div className="sftp-file-table" role="list">
        <div className="sftp-column-head"><span>{t("sftp:name")}</span><span>{t("sftp:size")}</span><span>{t("sftp:modified")}</span><span>{t("sftp:mode")}</span></div>
        {p.loading ? <div className="sftp-placeholder"><LoaderCircle className="spin" size={17}/>{t("sftp:loading")}</div>
        : p.error ? <div className="sftp-placeholder sftp-error">{errorText(p.error)}</div>
        : visible.length === 0 ? <div className="sftp-placeholder">{t("sftp:emptyFolder")}</div>
        : visible.map(entry => (
          <button type="button" role="listitem" key={entry.path}
            className={`sftp-file-row ${p.selected.includes(entry.path) ? "selected" : ""}`}
            draggable={!entry.isSymlink}
            onDragStart={event => event.dataTransfer.setData("application/x-openshell-entry",JSON.stringify({side:p.side,path:entry.path}))}
            onClick={event=>p.onSelect(entry,event.ctrlKey||event.metaKey)}
            onDoubleClick={()=>{if(entry.isSymlink)return;if(entry.isDir)p.onDir(entry.path);else p.onOpenFile?.(entry);}}
            onContextMenu={event=>p.onContext(event,entry)}>
            <span className="sftp-file-name">{entry.isDir ? <Folder size={15}/> : <File size={15}/>}<span title={entry.path}>{entry.name}</span>{entry.isSymlink && <span className="sftp-link-badge">↗</span>}</span>
            <span>{entry.isDir ? "—" : niceSize(entry.size)}</span>
            <span>{new Date(entry.modified).toLocaleDateString(i18n.language === "zh-CN" ? "zh-CN" : "en-US")}</span><span>{entry.mode}</span>
          </button>
        ))}
      </div>
      <div className="sftp-panel-footer">
        <span>{t("sftp:fileCount", { count: visible.length })}</span>
        <button className="sftp-primary" disabled={!p.selected.length} onClick={p.onTransfer}>
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
  const [remoteDir,setRemoteDir] = useState("");
  const [localFiles,setLocalFiles] = useState<SFTPEntry[]>([]);
  const [remoteFiles,setRemoteFiles] = useState<SFTPEntry[]>([]);
  const [localBusy,setLocalBusy] = useState(false);
  const [remoteBusy,setRemoteBusy] = useState(false);
  const [localError,setLocalError] = useState<unknown>("");
  const [remoteError,setRemoteError] = useState<unknown>("");
  const [selection,setSelection] = useState<Record<Side,string[]>>({local:[],remote:[]});
  const [hidden,setHidden] = useState(false);
  const [version,setVersion] = useState(0);
  const [tasks,setTasks] = useState<SFTPTask[]>([]);
  const [queueOpen,setQueueOpen] = useState(true);
  const [editor,setEditor] = useState<SFTPDocument|null>(null);
  const [draftText,setDraftText] = useState("");
  const [editorSaving,setEditorSaving] = useState(false);
  const [syncBusy,setSyncBusy] = useState(false);
  const [menu,setMenu] = useState<{x:number;y:number;anchor:HTMLElement;items:ContextMenuAction[]}|null>(null);

  useEffect(() => {
    let alive=true;
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
    api.SFTPTransfers(refID).then(list=>{if(alive)setTasks(list??[]);}).catch(()=>{});
    return ()=>{alive=false;};
  },[refID.tabId,refID.sessionId,refID.generation]);
  useEffect(()=>{
    if(!localDir)return;
    let alive=true;setLocalBusy(true);setLocalError("");
    api.SFTPList(refID,"local",localDir).then(items=>{if(alive)setLocalFiles(items??[]);})
      .catch(error=>{if(alive){setLocalFiles([]);setLocalError(error);}})
      .finally(()=>{if(alive)setLocalBusy(false);});
    return ()=>{alive=false;};
  },[refID.tabId,refID.generation,localDir,version]);
  useEffect(()=>{
    if(!remoteDir)return;
    let alive=true;setRemoteBusy(true);setRemoteError("");
    api.SFTPList(refID,"remote",remoteDir).then(items=>{if(alive)setRemoteFiles(items??[]);})
      .catch(error=>{if(alive){setRemoteFiles([]);setRemoteError(error);}})
      .finally(()=>{if(alive)setRemoteBusy(false);});
    return ()=>{alive=false;};
  },[refID.tabId,refID.generation,remoteDir,version]);
  useEffect(()=>{
    const off=listen("sftp:transfer",(task:SFTPTask)=>{
      if(task.ref.tabId!==refID.tabId||task.ref.generation!==refID.generation)return;
      setTasks(old=>[...old.filter(t=>t.id!==task.id),task].sort((a,b)=>a.created-b.created));
      if(task.status==="completed")setVersion(v=>v+1);
    });
    return ()=>off();
  },[refID.tabId,refID.generation]);

  const transfer = async (side:Side, paths:string[], dstDir:string) => {
    if (!dstDir) return;
    const direction = side==="local" ? "upload" : "download";
    const destSide = side==="local" ? "remote" : "local";
    try {
      // The visible listing may be stale while uploads are queued. Resolve
      // destination conflicts from the current filesystem, not React state.
      const destinationNames = new Set((await api.SFTPList(refID, destSide, dstDir)).map(item => item.name));
      for(const file of paths) {
        const name = basename(file);
        const existing = destinationNames.has(name);
        let overwrite = false;
        if (existing) {
          overwrite = await dialogs.confirm({
            title:t("sftp:overwriteTitle"), description:t("sftp:overwriteDescription",{name:basename(file)}),
            tone:"warning",confirmLabel:t("sftp:overwrite")
          });
          if (!overwrite) continue;
        }
        await api.SFTPTransfer(refID,direction,file,join(destSide,dstDir,name),overwrite,true);
        destinationNames.add(name);
      }
    }catch(error){onNotice(error);}
  };
  useEffect(() => {
    if (remoteDir) onRemoteDirectoryChange?.(remoteDir);
  }, [remoteDir, refID.tabId, refID.generation]);

  const changeDir = (side:Side, directory:string) => {
    if(!directory)return;
    if(side==="local")setLocalDir(directory);else setRemoteDir(directory);
    setSelection(s=>({...s,[side]:[]}));
  };
  const choose = (side:Side,item:SFTPEntry,multi:boolean) => {
    setSelection(s=>{
      const previous=s[side];
      return {...s,[side]:multi ? previous.includes(item.path) ? previous.filter(x=>x!==item.path) : [...previous,item.path] : [item.path]};
    });
  };
  const operate = async (side:Side, operation:Operation, entry?:SFTPEntry) => {
    const files=side==="local" ? localFiles : remoteFiles;
    const dir=side==="local" ? localDir : remoteDir;
    const selected=entry ? [entry] : files.filter(f=>selection[side].includes(f.path));
    if(operation!=="mkdir"&&!selected.length)return;
    try {
      if(operation==="mkdir") {
        const name=await dialogs.input({title:t("sftp:newFolder"),label:t("sftp:newFolderName"),icon:"create"});
        if(name===null)return;
        if(!validName(name)){onNotice(t("sftp:invalidName"));return;}
        await api.SFTPOperate(refID,side,"mkdir",join(side,dir,name),"");
      } else if(operation==="delete") {
        const accepted=await dialogs.confirm({title:t("sftp:deleteTitle"),description:t("sftp:deleteWarning",{name:selected.length===1?selected[0].name:t("sftp:itemCount", { count: selected.length })}),tone:"danger",confirmLabel:t("sftp:delete")});
        if(!accepted)return;
        for(const file of selected)await api.SFTPOperate(refID,side,"delete",file.path,"");
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
      setVersion(v=>v+1);
      setSelection(s=>({...s,[side]:[]}));
    }catch(error){onNotice(error);}
  };
  const context = (event:MouseEvent<HTMLButtonElement>,side:Side,item:SFTPEntry) => {
    event.preventDefault();
    const other = side==="local" ? remoteDir : localDir;
    const items:ContextMenuAction[] = [
      {label:t(side==="local"?"sftp:upload":"sftp:download"),icon:side==="local"?ArrowUpFromLine:ArrowDownToLine,onSelect:()=>void transfer(side,[item.path],other)},
      ...(side==="remote" && !item.isDir && !item.isSymlink ? [{label:t("sftp:editText"),icon:FileText,onSelect:()=>void openEditor(item)}] : []),
      {label:t("sftp:rename"),icon:Pencil,onSelect:()=>void operate(side,"rename",item)},
      {label:t("sftp:chmod"),icon:Shield,onSelect:()=>void operate(side,"chmod",item)},
      {label:t("sftp:copyPath"),icon:ClipboardCopy,onSelect:()=>void navigator.clipboard.writeText(item.path)},
      {label:t("sftp:delete"),icon:Trash2,danger:true,separatorBefore:true,onSelect:()=>void operate(side,"delete",item)}
    ];
    setSelection(s=>({...s,[side]:[item.path]}));
    setMenu({x:event.clientX,y:event.clientY,anchor:event.currentTarget,items});
  };
  const drop = (target:Side,event:DragEvent<HTMLElement>) => {
    const raw=event.dataTransfer.getData("application/x-openshell-entry");
    if(!raw)return;
    event.preventDefault();
    try {
      const source=JSON.parse(raw) as {side:Side;path:string};
      if(source.side!==target && source.path)void transfer(source.side,[source.path],target==="remote"?remoteDir:localDir);
    }catch{ /* ignore unrelated drags */ }
  };
  const openEditor = async (entry:SFTPEntry) => {
    try {
      const doc=await api.SFTPReadRemoteText(refID,entry.path);
      setEditor(doc);setDraftText(doc.content);
    }catch(error){onNotice(error);}
  };
  const closeEditor = async () => {
    if(editor && draftText!==editor.content){
      const ok=await dialogs.confirm({title:t("sftp:discardEditorTitle"),description:t("sftp:discardEditorDescription"),tone:"warning",confirmLabel:t("sftp:discard")});
      if(!ok)return;
    }
    setEditor(null);
  };
  const saveEditor = async () => {
    if(!editor||editorSaving)return;
    setEditorSaving(true);
    try {
      const next=await api.SFTPSaveRemoteText(refID,editor.path,editor.revision,draftText);
      setEditor(next);setDraftText(next.content);setVersion(v=>v+1);
    }catch(error){onNotice(error);}
    finally{setEditorSaving(false);}
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
      for(const item of selected){
        const destSide=direction==="upload"?"remote":"local";
        await api.SFTPEnsureDirectory(refID,destSide,parent(destSide,item.destination));
        await api.SFTPTransfer(refID,direction,item.source,item.destination,item.reason==="changed",true);
      }
      setVersion(v=>v+1);
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
        <FilePanel side="local" directory={localDir} entries={localFiles} selected={selection.local} loading={localBusy} error={localError} showHidden={hidden}
          onToggleHidden={()=>setHidden(s=>!s)} onChooseDirectory={()=>void api.SFTPChooseDirectory().then(dir=>{if(dir)changeDir("local",dir);}).catch(onNotice)} onDir={dir=>changeDir("local",dir)} onReload={()=>setVersion(v=>v+1)}
          onSelect={(item,multi)=>choose("local",item,multi)} onTransfer={()=>void transfer("local",selection.local,remoteDir)}
          onOperate={(action,entry)=>void operate("local",action,entry)} onContext={(event,item)=>context(event,"local",item)}
          onFileDrop={event=>drop("local",event)}/>
        <FilePanel side="remote" directory={remoteDir} entries={remoteFiles} selected={selection.remote} loading={remoteBusy} error={remoteError} showHidden={hidden}
          onToggleHidden={()=>setHidden(s=>!s)} onDir={dir=>changeDir("remote",dir)} onReload={()=>setVersion(v=>v+1)}
          onCwdHelp={!cwdReported ? () => void ClipboardSetText(BASH_CWD_REPORT_COMMAND).then(copied => {
            if (!copied) throw new Error(t("sftp:cwdCommandCopyFailed"));
            onNotice(t("sftp:cwdCommandCopied"));
          }).catch(onNotice) : undefined}
          onOpenFile={item=>void openEditor(item)} onSelect={(item,multi)=>choose("remote",item,multi)} onTransfer={()=>void transfer("remote",selection.remote,localDir)}
          onOperate={(action,entry)=>void operate("remote",action,entry)} onContext={(event,item)=>context(event,"remote",item)}
          onFileDrop={event=>drop("remote",event)}/>
      </div>
      <div className="sftp-sync-controls">
        <span><ArrowLeftRight size={13}/>{t("sftp:syncFolders")}</span>
        <button disabled={syncBusy} onClick={()=>void sync("upload")}><ArrowUpFromLine size={13}/>{t("sftp:syncUpload")}</button>
        <button disabled={syncBusy} onClick={()=>void sync("download")}><ArrowDownToLine size={13}/>{t("sftp:syncDownload")}</button>
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
      {editor && (
        <div className="sftp-editor-backdrop">
          <section className="sftp-editor" role="dialog" aria-modal="true" aria-label={t("sftp:editText")}>
            <header><strong><FileText size={15}/>{editor.path}</strong><button title={t("common:close")} onClick={()=>void closeEditor()}><X size={17}/></button></header>
            <textarea aria-label={t("sftp:editText")} value={draftText} spellCheck={false} onChange={event=>setDraftText(event.target.value)}/>
            <footer><small>{t("sftp:utf8EditorLimit")}</small><button onClick={()=>void closeEditor()}>{t("common:cancel")}</button>
              <button disabled={editorSaving||draftText===editor.content} className="sftp-editor-save" onClick={()=>void saveEditor()}><Save size={14}/>{t("sftp:saveFile")}</button>
            </footer>
          </section>
        </div>
      )}
      {menu && <FloatingContextMenu {...menu} onClose={()=>setMenu(null)}/>}
    </div>
  );
}
function validName(value:string){
  return Boolean(value && value!=="." && value!==".." && !/[\/\\\0]/.test(value));
}
