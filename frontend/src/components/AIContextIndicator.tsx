import { useEffect, useRef, useState } from "react";
import type { AIContextStats } from "../types";
import { t } from "../i18n";

interface Props {
  stats: AIContextStats | null;
  compacting: boolean;
  disabled: boolean;
  onCompact(): void;
  autoCompact?: boolean;
  compactThreshold?: number;
  historyOpen?: boolean;
  onOpen?(): void;
}

export default function AIContextIndicator({ stats, compacting, disabled, onCompact, autoCompact = true, compactThreshold = 90, historyOpen = false, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (historyOpen) setOpen(false);
  }, [historyOpen]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const window = stats?.window || 32768;
  const used = stats?.estimatedTokens || 0;
  const percentage = Math.min(100, Math.round(100 * used / window));
  const state = percentage >= (autoCompact ? compactThreshold : 90) ? "critical" : percentage >= 70 ? "warning" : "normal";
  return <div className="ai-context-control" ref={rootRef}>
    <button ref={triggerRef} type="button" className={"ai-context-ring is-" + state} aria-label={t("ai:contextUsage")}
      title={t("ai:contextUsage") + ": " + used + "/" + window}
      aria-expanded={open} onClick={() => { if (!open) onOpen?.(); setOpen(!open); }}>
      <svg viewBox="0 0 30 30" width="28" height="28" aria-hidden="true">
        <circle cx="15" cy="15" r="12" fill="none" stroke="currentColor" opacity=".16" strokeWidth="3" />
        <circle cx="15" cy="15" r="12" fill="none" stroke="currentColor" strokeWidth="3"
          strokeLinecap="round" transform="rotate(-90 15 15)"
          strokeDasharray={(percentage * 0.754) + " 75.4"} />
        <text x="15" y="18" textAnchor="middle" fontSize="9" fill="currentColor">{percentage}</text>
      </svg>
    </button>
    {open && <div className="ai-context-popover" role="dialog" aria-label={t("ai:contextUsage")}>
      <strong>{t("ai:contextUsage")}</strong>
      <p>{used.toLocaleString()} / {window.toLocaleString()} ({percentage}%)</p>
      <p className="ai-context-note">{t("ai:contextEstimated")}</p>
      {!!stats?.lastPromptTokens && <p className="ai-context-note">{t("ai:lastPromptTokens")}: {stats.lastPromptTokens.toLocaleString()}</p>}
      <div className="ai-context-row"><span>{t("ai:autoCompact")}</span><span>{autoCompact ? t("ai:atThreshold", { threshold: compactThreshold }) : t("ai:autoCompactOff")}</span></div>
      <div className="ai-context-row"><span>{t("ai:compactCount")}</span><span>{stats?.compactionCount || 0}</span></div>
      <button type="button" className="ai-context-compact" disabled={disabled || compacting}
        onClick={onCompact}>{compacting ? t("ai:compacting") : t("ai:compactNow")}</button>
    </div>}
  </div>;
}
