import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Copy, Layers, PanelRightClose, Plus, RefreshCw, Server, Unplug, X } from "lucide-react";
import { t } from "../i18n";
import type { DisconnectBehavior, Tab } from "../types";
import ConnectionStatusIcon from "./ConnectionStatusIcon";
import { reorderFromInsertion, tabEdgeScrollSpeed, tabInsertionIndex } from "../features/sessions/tabPointerDrag";

type Placement = "before" | "after";
interface DragPreview { id: string; x: number; y: number; insertion: number; width: number }

interface Props {
  tabs: Tab[];
  activeID: string;
  unreadTabIDs?: ReadonlySet<string>;
  disconnectBehavior: DisconnectBehavior;
  onActivate(tabID: string): void;
  onDuplicate(tab: Tab): void;
  onClose(tab: Tab): void;
  onCloseTabs?(tabs: Tab[]): void;
  onReconnect?(tab: Tab): void;
  onDisconnect?(tab: Tab): void;
  onNewTab(): void;
  onReorder(sourceID: string, targetID: string, placement: Placement): void;
  onTabDragStart?(tabID: string): void;
  onTabPointerMove?(tabID: string, x: number, y: number): void;
  onTabPointerDrop?(tabID: string, x: number, y: number): void;
  onTabDragEnd?(): void;
  onDropOnStrip?(tabID: string): void;
}

export default function WorkspaceTabStrip(p: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragPreview | null>(null);
  const [contextMenu, setContextMenu] = useState<{ tabID: string; x: number; y: number } | null>(null);
  const point = useRef({ x: 0, y: 0 });
  const dragging = useRef("");
  const frame = useRef<number | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const tabOrder = p.tabs.map(tab => tab.id).join(",");

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const activeTab = Array.from(strip?.querySelectorAll<HTMLElement>(".terminal-tab") ?? [])
      .find(tab => tab.dataset.tabId === p.activeID);
    if (!strip || !activeTab) return;

    const revealActiveTab = () => {
      const stripBounds = strip.getBoundingClientRect();
      const tabBounds = activeTab.getBoundingClientRect();
      if (tabBounds.left < stripBounds.left) {
        strip.scrollLeft += tabBounds.left - stripBounds.left;
      } else if (tabBounds.right > stripBounds.right) {
        strip.scrollLeft += tabBounds.right - stripBounds.right;
      }
    };

    revealActiveTab();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(revealActiveTab);
    observer.observe(strip);
    observer.observe(activeTab);
    return () => observer.disconnect();
  }, [p.activeID, tabOrder]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || strip.scrollWidth <= strip.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) return;
      const scale = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? strip.clientWidth : 1;
      if (event.cancelable) event.preventDefault();
      strip.scrollLeft += delta * scale;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => () => {
    cleanup.current?.();
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest(".tab-context-menu")) setContextMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setContextMenu(null);
      }
    };
    const onBlur = () => setContextMenu(null);
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [contextMenu]);

  const openContextMenu = (tabID: string, event: ReactMouseEvent) => {
    if (dragging.current) return;
    event.preventDefault();
    event.stopPropagation();
    const width = 226;
    const height = 260;
    setContextMenu({
      tabID,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
    });
  };
  const menuTab = p.tabs.find(tab => tab.id === contextMenu?.tabID);
  const menuIndex = menuTab ? p.tabs.findIndex(tab => tab.id === menuTab.id) : -1;
  const closeOthers = menuTab ? p.tabs.filter(tab => tab.id !== menuTab.id) : [];
  const closeRight = menuIndex >= 0 ? p.tabs.slice(menuIndex + 1) : [];
  const menuAction = (action: () => void) => {
    setContextMenu(null);
    action();
  };

  const moveWithKeyboard = (tabID: string, index: number, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!event.altKey || !event.shiftKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const offset = event.key === "ArrowLeft" ? -1 : 1;
    const neighbor = p.tabs[index + offset];
    if (neighbor) p.onReorder(tabID, neighbor.id, offset < 0 ? "before" : "after");
  };

  const beginDrag = (tabID: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    cleanup.current?.();
    suppressClick.current = false;
    const pointerID = event.pointerId;
    const origin = { x: event.clientX, y: event.clientY };
    point.current = origin;
    const stripAtStart = stripRef.current;
    const initialScrollLeft = stripAtStart?.scrollLeft ?? 0;
    const initialTabBounds = Array.from(stripAtStart?.querySelectorAll<HTMLElement>(".terminal-tab") ?? [])
      .map(el => {
        const bounds = el.getBoundingClientRect();
        return { id: el.dataset.tabId ?? "", left: bounds.left, width: bounds.width };
      });
    const scrollOffset = () => (stripRef.current?.scrollLeft ?? initialScrollLeft) - initialScrollLeft;
    const insertionAt = (x: number) => tabInsertionIndex(
      initialTabBounds.map(tab => ({ ...tab, left: tab.left - scrollOffset() })), tabID, x);
    const lastTabRight = () => {
      const last = initialTabBounds[initialTabBounds.length - 1];
      return last ? last.left + last.width - scrollOffset() : origin.x;
    };
    let started = false;
    let lastFrame = 0;
    const scroll = (timestamp: number) => {
      if (!started) return;
      const elapsed = lastFrame ? Math.min(40, timestamp - lastFrame) : 16;
      lastFrame = timestamp;
      const strip = stripRef.current;
      if (strip) {
        const bounds = strip.getBoundingClientRect();
        const inside = point.current.y >= bounds.top && point.current.y <= bounds.bottom;
        const speed = inside ? tabEdgeScrollSpeed(point.current.x, bounds.left, bounds.right) : 0;
        if (speed && strip.scrollWidth > strip.clientWidth) {
          strip.scrollLeft += speed * elapsed * 0.65;
          setDrag(previous => previous && previous.id === tabID
            ? { ...previous, insertion: insertionAt(point.current.x) } : previous);
        }
      }
      frame.current = requestAnimationFrame(scroll);
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerID) return;
      point.current = { x: move.clientX, y: move.clientY };
      if (!started && Math.hypot(move.clientX - origin.x, move.clientY - origin.y) < 5) return;
      if (!started) {
        started = true;
        document.body.style.setProperty("user-select", "none");
        dragging.current = tabID;
        suppressClick.current = true;
        p.onTabDragStart?.(tabID);
        frame.current = requestAnimationFrame(scroll);
      }
      const bounds = stripRef.current?.getBoundingClientRect();
      const inside = !!bounds && move.clientY >= bounds.top && move.clientY <= bounds.bottom &&
        move.clientX >= bounds.left && move.clientX <= bounds.right;
      const width = stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${tabID}"]`)
        ?.getBoundingClientRect().width ?? 140;
      setDrag({ id: tabID, x: move.clientX, y: move.clientY,
        insertion: inside ? insertionAt(move.clientX) : -1, width });
      p.onTabPointerMove?.(tabID, move.clientX, move.clientY);
      move.preventDefault();
    };
    const stop = (up: PointerEvent, canceled = false) => {
      if (up.pointerId !== pointerID) return;
      cleanup.current?.();
      if (started && !canceled) {
        const strip = stripRef.current;
        const bounds = strip?.getBoundingClientRect();
        const inside = !!bounds && up.clientX >= bounds.left && up.clientX <= bounds.right &&
          up.clientY >= bounds.top && up.clientY <= bounds.bottom;
        if (inside) {
          const rightEdge = lastTabRight();
          if (up.clientX > rightEdge + 8) {
            p.onDropOnStrip?.(tabID);
          } else {
            const move = reorderFromInsertion(p.tabs.map(tab => tab.id), tabID, insertionAt(up.clientX));
            if (move) p.onReorder(tabID, move.targetID, move.placement);
          }
        } else {
          p.onTabPointerDrop?.(tabID, up.clientX, up.clientY);
        }
      }
      if (started) p.onTabDragEnd?.();
      dragging.current = "";
      setDrag(null);
    };
    const onUp = (up: PointerEvent) => stop(up);
    const onCancel = (up: PointerEvent) => stop(up, true);
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      stop({ pointerId: pointerID } as PointerEvent, true);
    };
    const onBlur = () => stop({ pointerId: pointerID } as PointerEvent, true);
    const release = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      document.body.style.removeProperty("user-select");
      cleanup.current = null;
    };
    cleanup.current = release;
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
  };

  const draggedIndex = p.tabs.findIndex(tab => tab.id === drag?.id);
  const draggedTab = p.tabs.find(tab => tab.id === drag?.id);
  return (
    <>
      <div className="tab-strip" ref={stripRef} role="group" aria-label={t("common:sessionTabs")}>
        {p.tabs.map((tab, index) => {
          const shiftingLeft = !!drag && drag.insertion >= 0 && index > draggedIndex &&
            index <= drag.insertion;
          const shiftingRight = !!drag && drag.insertion >= 0 && index < draggedIndex &&
            index >= drag.insertion;
          const shift = shiftingLeft ? -drag!.width : shiftingRight ? drag!.width : 0;
          const hasActivity = p.activeID !== tab.id && p.unreadTabIDs?.has(tab.id);
          return (
            <div key={tab.id} data-tab-id={tab.id}
              onContextMenu={event => openContextMenu(tab.id, event)}
              className={`terminal-tab ${p.activeID === tab.id ? "active" : ""} ${drag?.id === tab.id ? "dragging" : ""}`}
              style={{ transform: shift ? `translateX(${shift}px)` : undefined }}>
              <button title={t("common:doubleClickToDuplicateSession")}
                aria-label={`${t("common:sessionTabDescription", { name: tab.session.name })}${hasActivity ? ` ${t("common:backgroundSessionOutput")}` : ""}`}
                aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
                onPointerDown={event => beginDrag(tab.id, event)}
                onKeyDown={event => moveWithKeyboard(tab.id, index, event)}
                onClick={event => {
                  if (suppressClick.current) {
                    event.preventDefault();
                    suppressClick.current = false;
                    return;
                  }
                  p.onActivate(tab.id);
                }}
                onDoubleClick={() => { if (!dragging.current) p.onDuplicate(tab); }}>
                <ConnectionStatusIcon status={tab.status}
                  localShell={p.disconnectBehavior === "local" && !!tab.ref && !!tab.everConnected
                    && !tab.localFallbackPending} />
                <span>{tab.session.name}</span>
                {hasActivity && <span className="terminal-tab-activity" title={t("common:backgroundSessionOutput")} aria-hidden="true" />}
              </button>
              <button className="terminal-tab-close"
                title={t("common:closeTab", { name: tab.session.name })}
                onClick={() => p.onClose(tab)}>
                <X size={14} />
              </button>
            </div>
          );
        })}
        <button className="new-tab" title={t("common:openSessionList")} onClick={p.onNewTab}>
          <Plus size={16} />
        </button>
      </div>
      {drag && draggedTab && createPortal(
        <div className="tab-drag-overlay" style={{
          left: drag.x + 12, top: drag.y + 12,
        }} aria-hidden="true">
          <Server size={14} />
          <span>{draggedTab.session.name}</span>
        </div>,
        document.body,
      )}
      {contextMenu && menuTab && createPortal(
        <div className="tab-context-menu" role="menu" aria-label={t("common:sessionActions")}
          style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button type="button" role="menuitem" onClick={() => menuAction(() => p.onDuplicate(menuTab))}>
            <Copy size={15} />{t("common:duplicateCurrentTab")}
          </button>
          <button type="button" role="menuitem"
            disabled={!p.onReconnect || !["disconnected", "error"].includes(menuTab.status)}
            onClick={() => menuAction(() => p.onReconnect?.(menuTab))}>
            <RefreshCw size={15} />{t("common:reconnect")}
          </button>
          <button type="button" role="menuitem"
            disabled={!p.onDisconnect || !["connected", "connecting", "reconnecting"].includes(menuTab.status)}
            onClick={() => menuAction(() => p.onDisconnect?.(menuTab))}>
            <Unplug size={15} />{t("common:disconnect")}
          </button>
          <div className="tab-context-menu-divider" role="separator" />
          <button type="button" role="menuitem" onClick={() => menuAction(() => p.onClose(menuTab))}>
            <X size={15} />{t("common:closeCurrentTab")}
          </button>
          <button type="button" role="menuitem" disabled={!p.onCloseTabs || !closeOthers.length}
            onClick={() => menuAction(() => p.onCloseTabs?.(closeOthers))}>
            <Layers size={15} />{t("common:closeOtherTabs")}
          </button>
          <button type="button" role="menuitem" disabled={!p.onCloseTabs || !closeRight.length}
            onClick={() => menuAction(() => p.onCloseTabs?.(closeRight))}>
            <PanelRightClose size={15} />{t("common:closeTabsToRight")}
          </button>
          <button type="button" role="menuitem" disabled={!p.onCloseTabs || !p.tabs.length}
            onClick={() => menuAction(() => p.onCloseTabs?.(p.tabs))}>
            <X size={15} />{t("common:closeAllTabs")}
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
