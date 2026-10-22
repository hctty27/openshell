import { Plus, Pencil, Trash2, MoreHorizontal } from "lucide-react";
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
  const current = p.items.find((c) => c.id === p.selectedID);
  return (
    <div className="conversation-picker">
      <select
        aria-label={t("ai:currentConversation")}
        value={p.selectedID}
        disabled={p.busy}
        title={current?.title || t("ai:newConversation")}
        onChange={(e) => p.onSelect(e.target.value)}
      >
        {!current && (
          <option value={p.selectedID}>{t("ai:newConversation")}</option>
        )}
        {p.items.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title || t("ai:newConversation")}
            {c.updatedAt
              ? " · " +
                new Date(c.updatedAt).toLocaleString(i18n.language, {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : ""}
          </option>
        ))}
      </select>
      <button
        title={t("ai:newConversation")}
        disabled={p.busy}
        onClick={p.onCreate}
      >
        <Plus size={14} />
      </button>
      <button
        title={t("ai:renameConversation")}
        disabled={p.busy || p.locked}
        onClick={() => p.onRename(p.selectedID)}
      >
        <Pencil size={13} />
      </button>
      <button
        title={t("ai:deleteConversation")}
        disabled={p.busy || p.locked}
        onClick={() => p.onDelete(p.selectedID)}
      >
        <Trash2 size={13} />
      </button>
      {p.hasMore && (
        <button
          title={t("ai:loadMoreConversations")}
          disabled={p.busy}
          onClick={p.onLoadMore}
        >
          <MoreHorizontal size={14} />
        </button>
      )}
    </div>
  );
}
