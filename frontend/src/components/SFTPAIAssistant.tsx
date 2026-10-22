import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpFromLine, FileSearch, GitCompare, LoaderCircle, Pencil, ScrollText, Sparkles, X } from "lucide-react";
import { api } from "../bridge";
import { t } from "../i18n";
import { useDialogs } from "./DialogProvider";
import type { Ref, SFTPAIMode, SFTPAIResponse } from "../types";

interface Props {
  refID: Ref;
  profileID: string;
  remoteDir: string;
  localPaths: string[];
  remotePaths: string[];
  onReview(response: SFTPAIResponse): void;
  onUpload(response: SFTPAIResponse): Promise<void>;
  onNotice(error: unknown): void;
}

const modes: { value: SFTPAIMode; icon: typeof Sparkles }[] = [
  { value: "analyze", icon: FileSearch },
  { value: "log", icon: ScrollText },
  { value: "compare", icon: GitCompare },
  { value: "edit", icon: Pencil },
  { value: "upload", icon: ArrowUpFromLine },
];

export default function SFTPAIAssistant({
  refID, profileID, remoteDir, localPaths, remotePaths, onReview, onUpload, onNotice,
}: Props) {
  useTranslation();
  const dialogs = useDialogs();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SFTPAIMode>("analyze");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SFTPAIResponse | null>(null);

  useEffect(() => { setResult(null); }, [refID.tabId, refID.generation, remoteDir, mode,
    remotePaths.join("\u0000"), localPaths.join("\u0000")]);

  const paths = mode === "upload" ? localPaths : remotePaths;
  const valid = mode === "compare" ? paths.length === 2 : paths.length === 1;
  const run = async () => {
    if (!valid || !profileID || busy) return;
    const accepted = await dialogs.confirm({
      title: t("sftp:aiShareTitle"),
      description: t(mode === "upload" ? "sftp:aiShareMetadata" : "sftp:aiShareFile"),
      preview: paths.join("\n"),
      tone: "warning",
      confirmLabel: t("sftp:aiStart"),
    });
    if (!accepted) return;
    setBusy(true);
    setResult(null);
    try {
      const response = await api.SFTPAIAssist({
        ref: refID, profileId: profileID, mode, paths, remoteDir, instruction,
      });
      setResult(response);
    } catch (error) {
      onNotice(error);
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <button className="sftp-ai-toggle" onClick={() => setOpen(true)}>
        <Sparkles size={14}/>{t("sftp:aiAssistant")}
      </button>
    );
  }
  return (
    <section className="sftp-ai-panel" aria-label={t("sftp:aiAssistant")}>
      <div className="sftp-ai-header">
        <strong><Sparkles size={14}/>{t("sftp:aiAssistant")}</strong>
        <small>{t("sftp:aiModelNote")}</small>
        <button title={t("common:close")} onClick={() => setOpen(false)}><X size={15}/></button>
      </div>
      <div className="sftp-ai-controls">
        <label>
          <span>{t("sftp:aiAction")}</span>
          <select aria-label={t("sftp:aiAction")} value={mode} onChange={e => setMode(e.target.value as SFTPAIMode)}>
            {modes.map(item => <option key={item.value} value={item.value}>{t("sftp:aiMode_" + item.value)}</option>)}
          </select>
        </label>
        <input aria-label={t("sftp:aiInstruction")} value={instruction} maxLength={1000}
          placeholder={t("sftp:aiInstruction")} onChange={event=>setInstruction(event.target.value)}/>
        <button className="sftp-ai-run" disabled={busy || !valid || !profileID} onClick={()=>void run()}>
          {busy ? <LoaderCircle className="spin" size={13}/> : <Sparkles size={13}/>}
          {t("sftp:aiStart")}
        </button>
      </div>
      <small className="sftp-ai-hint">
        {valid ? t("sftp:aiReadOnlyNotice") :
          t(mode === "compare" ? "sftp:aiChooseTwo" : mode === "upload" ? "sftp:aiChooseLocal" : "sftp:aiChooseRemote")}
      </small>
      {result && <div className="sftp-ai-result">
        <pre>{result.summary}</pre>
        {result.truncated && <small>{t("sftp:aiTruncated")}</small>}
        {result.mode === "edit" && <button onClick={()=>onReview(result)}>
          <Pencil size={13}/>{t("sftp:aiReviewEdit")}
        </button>}
        {result.mode === "upload" && <button onClick={()=>void onUpload(result).catch(onNotice)}>
          <ArrowUpFromLine size={13}/>{t("sftp:aiReviewUpload")} · {result.destination}
        </button>}
      </div>}
    </section>
  );
}
