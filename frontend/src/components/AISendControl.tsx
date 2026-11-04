import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Send } from "lucide-react";
import AIDropdownSurface from "./AIDropdownSurface";
import type { AIExecutionMode } from "../features/ai/executionModePreference";
import { t } from "../i18n";
import { useTranslation } from "react-i18next";

interface Props {
  mode: AIExecutionMode;
  disabled: boolean;
  modeDisabled?: boolean;
  onModeChange(mode: AIExecutionMode): void;
}

const modes: AIExecutionMode[] = ["review", "auto"];

export default function AISendControl({ mode, disabled, modeDisabled = false, onModeChange }: Props) {
  useTranslation("ai");
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuID = useId();

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (value: AIExecutionMode) => {
    onModeChange(value);
    close();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
      (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const modeLabel = t(mode === "auto" ? "ai:automaticMode" : "ai:reviewMode");

  return (
    <div className="ai-send-split" data-mode={mode}>
      <button className="ai-send-submit" type="submit"
        title={`${t("ai:send")} · ${modeLabel}`}
        aria-label={t("ai:send")} disabled={disabled}>
        <Send size={15} aria-hidden="true" />
      </button>
      <button className="ai-send-mode-trigger" ref={triggerRef} type="button"
        title={`${t("ai:executionMode")}：${modeLabel}`}
        aria-label={`${t("ai:executionMode")}：${modeLabel}`}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuID : undefined}
        disabled={modeDisabled}
        onClick={() => setOpen(current => !current)}
        onKeyDown={event => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      <AIDropdownSurface open={open} anchorRef={triggerRef} onDismiss={() => setOpen(false)}
        align="end" minWidth={162} maxHeight={180}>
        <div className="ai-send-mode-menu" role="menu" id={menuID}
          ref={menuRef} aria-label={t("ai:executionMode")} onKeyDown={onMenuKeyDown}>
          {modes.map(value => (
            <button key={value} type="button" role="menuitemradio" aria-checked={value === mode}
              onClick={() => choose(value)}>
              <span>{t(value === "auto" ? "ai:automaticMode" : "ai:reviewMode")}</span>
              {value === mode && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
      </AIDropdownSurface>
    </div>
  );
}
