import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { Check, Search, Trash2 } from "lucide-react";
import type { AIConversation } from "../types";
import { t } from "../i18n";

interface Props {
  items: AIConversation[];
  selectedID: string;
  query: string;
  onQueryChange(value: string): void;
  onSelect(item: AIConversation): void;
  onDelete(id: string): void;
  onClose(): void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  title: string;
  searchPlaceholder: string;
  terminal?: boolean;
}

function groupDate(value: string, today: string, yesterday: string): "today" | "yesterday" | "earlier" {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "earlier";
  const day = date.toDateString();
  return day === today ? "today" : day === yesterday ? "yesterday" : "earlier";
}

function displayDate(value: string, older: boolean): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const clock = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return older ? date.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" }) + " " + clock : clock;
}

export default function AIHistoryPopover({
  items, selectedID, query, onQueryChange, onSelect, onDelete, onClose, triggerRef, title, searchPlaceholder, terminal = false,
}: Props) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!popoverRef.current?.contains(target) && !triggerRef.current?.contains(target)) closeRef.current();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [triggerRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      triggerRef.current?.focus();
      return;
    }
    if (event.target === searchRef.current && (event.key === "Home" || event.key === "End")) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(popoverRef.current?.querySelectorAll<HTMLButtonElement>(".ai-history-choice") ?? []);
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 :
      event.key === "End" ? buttons.length - 1 :
      index < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1) :
      (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const todayDate = new Date();
  const yesterdayDate = new Date(todayDate);
  yesterdayDate.setDate(todayDate.getDate() - 1);
  const today = todayDate.toDateString();
  const yesterday = yesterdayDate.toDateString();
  const groups = [
    { key: "today", label: t("ai:historyToday") },
    { key: "yesterday", label: t("ai:historyYesterday") },
    { key: "earlier", label: t("ai:historyEarlier") },
  ] as const;

  return (
    <div className={"ai-history" + (terminal ? " ai-history--terminal" : "")} ref={popoverRef} role="dialog" aria-label={title} onKeyDown={onKeyDown}>
      <label className="ai-history-search">
        <Search size={14} aria-hidden="true" />
        <input ref={searchRef} type="search" value={query} onChange={event => onQueryChange(event.target.value)}
          placeholder={searchPlaceholder} aria-label={title + " - " + searchPlaceholder} />
      </label>
      <div className="ai-history-results">
        {groups.map(group => {
          const grouped = items.filter(item => groupDate(item.updatedAt, today, yesterday) === group.key);
          if (!grouped.length) return null;
          return <section key={group.key} className="ai-history-group" aria-label={group.label}>
            <div className="ai-history-group-label">{group.label}</div>
            {grouped.map(item => {
              const selected = item.id === selectedID;
              return <div key={item.id} className={"ai-history-entry" + (selected ? " is-active" : "")}>
                <button type="button" className="ai-history-choice" onClick={() => onSelect(item)}
                  title={item.title} aria-current={selected ? "true" : undefined}>
                  <span className="ai-history-entry-heading">
                    <span className="ai-history-entry-title">{item.title}</span>
                    {selected && <Check size={13} className="ai-history-selected" aria-hidden="true" />}
                  </span>
                  <small>{displayDate(item.updatedAt, group.key === "earlier")}{selected ? " · " + t("ai:currentConversation") : ""}</small>
                </button>
                <button type="button" className="ai-history-delete" title={t("ai:deleteConversation") + ": " + item.title}
                  aria-label={t("ai:deleteConversation")} onClick={() => onDelete(item.id)}>
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </div>;
            })}
          </section>;
        })}
        {items.length === 0 && <p className="ai-history-empty">{t("ai:noMatchingConversations")}</p>}
      </div>
    </div>
  );
}
