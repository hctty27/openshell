import { ChevronDown, Check, MessageSquare, Plus, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import type { Conversation } from "../types";

interface Props {
  items: Conversation[];
  selectedID: string;
  busy: boolean;
  locked: boolean;
  hasMore: boolean;
  onSelect(id: string): void;
  onCreate(): void;
  onRename(id: string): void;
  onDelete(id: string): void;
  onLoadMore(): void;
}

export default function ConversationPicker(p: Props) {
  const { i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [menuFor, setMenuFor] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const current = p.items.find((c) => c.id === p.selectedID);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
        setMenuFor("");
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setMenuFor("");
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  const title = current?.title || t("ai:newConversation");
  const time = (c: Conversation) =>
    c.updatedAt
      ? new Date(c.updatedAt).toLocaleString(i18n.language, {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";

  return (
    <div className="conversation-picker" ref={root}>
      <button
        className="conversation-trigger"
        aria-label={t("ai:currentConversation")}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={title}
        disabled={p.busy}
        onClick={() => setOpen((value) => !value)}
      >
        <MessageSquare size={13} />
        <span>{title}</span>
        <ChevronDown size={13} />
      </button>
      <button
        className="conversation-add"
        title={t("ai:newConversation")}
        aria-label={t("ai:newConversation")}
        disabled={p.busy}
        onClick={() => {
          setOpen(false);
          setMenuFor("");
          if (p.selectedID) p.onCreate();
        }}
      >
        <Plus size={15} />
      </button>
      {open && (
        <div className="conversation-menu" role="listbox" aria-label={t("ai:currentConversation")}>
          {!p.selectedID && (
            <div className="conversation-draft-row">
              <MessageSquare size={13} />
              <span>{t("ai:newConversation")}</span>
              <Check size={13} />
            </div>
          )}
          {p.items.map((c) => (
            <div
              key={c.id}
              className={`conversation-entry${menuFor === c.id ? " menu-open" : ""}`}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenuFor(c.id);
              }}
            >
              <button
                className="conversation-entry-title"
                role="option"
                aria-selected={p.selectedID === c.id}
                title={c.title || t("ai:newConversation")}
                disabled={p.busy}
                onClick={() => {
                  p.onSelect(c.id);
                  setOpen(false);
                  setMenuFor("");
                }}
              >
                <MessageSquare size={13} />
                <span className="conversation-entry-text">
                  <span>{c.title || t("ai:newConversation")}</span>
                  {time(c) && <small>{time(c)}</small>}
                </span>
                {p.selectedID === c.id && <Check size={13} className="conversation-selected-icon" />}
              </button>
              <div className="conversation-actions">
                <button
                  title={t("ai:renameConversation")}
                  disabled={p.busy || p.locked}
                  onClick={() => {
                    p.onRename(c.id);
                    setOpen(false);
                    setMenuFor("");
                  }}
                >
                  <Pencil size={13} />
                </button>
                <button
                  title={t("ai:deleteConversation")}
                  disabled={p.busy || p.locked}
                  onClick={() => {
                    p.onDelete(c.id);
                    setOpen(false);
                    setMenuFor("");
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
          {p.hasMore && (
            <button className="conversation-more" disabled={p.busy} onClick={p.onLoadMore}>
              {t("ai:loadMoreConversations")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
