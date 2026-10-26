import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
import { t } from "../i18n";
import type { DisconnectBehavior, Tab } from "../types";
import ConnectionStatusIcon from "./ConnectionStatusIcon";

type Placement = "before" | "after";

interface Props {
  tabs: Tab[];
  activeID: string;
  disconnectBehavior: DisconnectBehavior;
  onActivate(tabID: string): void;
  onDuplicate(tab: Tab): void;
  onClose(tab: Tab): void;
  onNewTab(): void;
  onReorder(sourceID: string, targetID: string, placement: Placement): void;
}

export default function WorkspaceTabStrip(p: Props) {
  const dragging = useRef("");
  const [draggedID, setDraggedID] = useState("");
  const [dropTarget, setDropTarget] = useState<{ id: string; placement: Placement } | null>(null);

  const clearDrag = () => {
    dragging.current = "";
    setDraggedID("");
    setDropTarget(null);
  };

  const startDrag = (tabID: string, event: DragEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(".terminal-tab-close")) {
      event.preventDefault();
      return;
    }
    dragging.current = tabID;
    setDraggedID(tabID);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", tabID);
  };

  const overTab = (tabID: string, event: DragEvent<HTMLDivElement>) => {
    if (!dragging.current || dragging.current === tabID) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const placement = event.clientX < bounds.left + bounds.width / 2 ? "before" : "after";
    setDropTarget(previous =>
      previous?.id === tabID && previous.placement === placement
        ? previous : { id: tabID, placement });
  };

  const dropOnTab = (tabID: string, event: DragEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    event.preventDefault();
    if (dragging.current !== tabID) {
      const bounds = event.currentTarget.getBoundingClientRect();
      p.onReorder(dragging.current, tabID,
        event.clientX < bounds.left + bounds.width / 2 ? "before" : "after");
    }
    clearDrag();
  };

  const moveWithKeyboard = (tabID: string, index: number, event: KeyboardEvent<HTMLButtonElement>) => {
    if (!event.altKey || !event.shiftKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const offset = event.key === "ArrowLeft" ? -1 : 1;
    const neighbor = p.tabs[index + offset];
    if (neighbor) p.onReorder(tabID, neighbor.id, offset < 0 ? "before" : "after");
  };

  return (
    <div className="tab-strip" role="group" aria-label={t("common:sessionTabs")}
      onDragOver={event => {
        if (!dragging.current) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left + 28) event.currentTarget.scrollLeft -= 14;
        if (event.clientX > bounds.right - 28) event.currentTarget.scrollLeft += 14;
      }}>
      {p.tabs.map((tab, index) => (
        <div key={tab.id} draggable
          className={`terminal-tab ${p.activeID === tab.id ? "active" : ""} ${draggedID === tab.id ? "dragging" : ""} ${dropTarget?.id === tab.id ? `drag-${dropTarget.placement}` : ""}`}
          onDragStart={event => startDrag(tab.id, event)}
          onDragOver={event => overTab(tab.id, event)}
          onDrop={event => dropOnTab(tab.id, event)}
          onDragEnd={clearDrag}>
          <button
            title={t("common:doubleClickToDuplicateSession")}
            aria-label={t("common:sessionTabDescription", { name: tab.session.name })}
            aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
            onKeyDown={event => moveWithKeyboard(tab.id, index, event)}
            onClick={() => p.onActivate(tab.id)}
            onDoubleClick={() => p.onDuplicate(tab)}
          >
            <ConnectionStatusIcon status={tab.status}
              localShell={p.disconnectBehavior === "local" && !!tab.ref && !!tab.everConnected
                && !tab.localFallbackPending} />
            <span>{tab.session.name}</span>
          </button>
          <button className="terminal-tab-close" draggable={false}
            title={t("common:closeTab", { name: tab.session.name })}
            onClick={() => p.onClose(tab)}>
            <X size={14} />
          </button>
        </div>
      ))}
      <button className="new-tab" title={t("common:openSessionList")} onClick={p.onNewTab}>
        <Plus size={16} />
      </button>
    </div>
  );
}
