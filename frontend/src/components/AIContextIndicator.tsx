import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AIContextStats } from "../types";
import { t } from "../i18n";

interface Props {
  stats: AIContextStats | null;
  compacting: boolean;
  disabled: boolean;
  disabledReason?: string;
  onCompact(): void;
  autoCompact?: boolean;
  compactThreshold?: number;
  historyOpen?: boolean;
  onOpen?(): void;
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 8;

export default function AIContextIndicator({
  stats, compacting, disabled, disabledReason, onCompact, autoCompact = true, compactThreshold = 90, historyOpen = false, onOpen,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const limit = Math.max(1, stats?.window || 32768);
  const used = Math.max(0, stats?.estimatedTokens || 0);
  const percentage = Math.min(100, Math.round(100 * used / limit));
  const state = percentage >= (autoCompact ? compactThreshold : 90) ? "critical" : percentage >= 70 ? "warning" : "normal";

  useEffect(() => {
    if (historyOpen) setOpen(false);
  }, [historyOpen]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
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

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const control = rootRef.current;
    const popover = popoverRef.current;
    if (!trigger || !control || !popover) return;
    const panel = trigger.closest(".ai-panel");

    const position = () => {
      const popupWidth = popover.getBoundingClientRect().width;
      const panelRight = panel?.getBoundingClientRect().right ?? trigger.getBoundingClientRect().right;
      const maxLeft = Math.max(8, window.innerWidth - popupWidth - 8);
      const left = Math.max(8, Math.min(panelRight - popupWidth - 8, maxLeft));
      popover.style.left = (left - control.getBoundingClientRect().left) + "px";
    };

    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    if (panel) observer?.observe(panel);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      observer?.disconnect();
    };
  }, [open]);

  return <div className="ai-context-control" ref={rootRef}>
    <button ref={triggerRef} type="button" className={"ai-context-ring is-" + state}
      aria-label={t("ai:contextUsage")}
      aria-description={percentage + "%"}
      title={t("ai:contextUsage") + ": " + used.toLocaleString() + "/" + limit.toLocaleString()}
      aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { if (!open) onOpen?.(); setOpen(value => !value); }}>
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" opacity=".16" strokeWidth="2.2" />
        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2.2"
          strokeLinecap="round" transform="rotate(-90 10 10)"
          strokeDasharray={percentage * RING_CIRCUMFERENCE / 100 + " " + RING_CIRCUMFERENCE} />
      </svg>
      <span className="ai-context-percent">{percentage}%</span>
    </button>
    {open && <div ref={popoverRef} className="ai-context-popover" role="dialog" aria-label={t("ai:contextUsage")}>
      <div className="ai-context-heading">
        <strong className="ai-context-title">{t("ai:contextUsage")}</strong>
        <strong className="ai-context-value">{percentage}%</strong>
      </div>
      <div className="ai-context-progress" role="progressbar" aria-label={t("ai:contextUsage")}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}>
        <span className={"is-" + state} style={{ width: percentage + "%" }} />
      </div>
      <div className="ai-context-tokens"
        title={stats?.lastPromptTokens ? t("ai:lastPromptTokens") + ": " + stats.lastPromptTokens.toLocaleString() : undefined}>
        <span>{used.toLocaleString()} / {limit.toLocaleString()} Tokens</span>
        {(stats?.isEstimate ?? true) && <span className="ai-context-estimated">{t("ai:contextEstimateShort")}</span>}
      </div>
      <div className="ai-context-divider" />
      <div className="ai-context-row"><span>{t("ai:autoCompact")}</span><span>{autoCompact ? compactThreshold + "%" : t("ai:autoCompactOff")}</span></div>
      <div className="ai-context-row"><span>{t("ai:compactCount")}</span><span>{stats?.compactionCount || 0}</span></div>
      <button type="button" className="ai-context-compact" disabled={disabled || compacting}
        title={disabled ? disabledReason : undefined}
        onClick={onCompact}>{compacting ? t("ai:compacting") : t("ai:compactAction")}</button>
      {disabled && disabledReason && <p className="ai-context-disabled-note">{disabledReason}</p>}
    </div>}
  </div>;
}
