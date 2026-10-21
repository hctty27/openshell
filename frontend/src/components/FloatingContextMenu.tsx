import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";

export interface ContextMenuAction {
  label: string;
  icon: LucideIcon;
  onSelect(): void;
  danger?: boolean;
  separatorBefore?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuAction[];
  anchor: HTMLElement;
  onClose(): void;
}

const EDGE_GAP = 8;

export default function FloatingContextMenu({ x, y, items, anchor, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(EDGE_GAP, Math.min(x, window.innerWidth - bounds.width - EDGE_GAP)),
      top: Math.max(EDGE_GAP, Math.min(y, window.innerHeight - bounds.height - EDGE_GAP)),
    });
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [x, y, items]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const escapeScroll = () => onClose();
    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("resize", escapeScroll);
    document.addEventListener("scroll", escapeScroll, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("resize", escapeScroll);
      document.removeEventListener("scroll", escapeScroll, true);
    };
  }, [onClose]);

  const focusItem = (index: number) => {
    const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    if (!buttons?.length) return;
    buttons[(index + buttons.length) % buttons.length].focus();
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="会话操作"
      className="session-context-menu"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          if (anchor.isConnected) anchor.focus();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          focusItem(index + (event.key === "ArrowDown" ? 1 : -1));
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          focusItem(event.key === "Home" ? 0 : items.length - 1);
        } else if (event.key === "Tab") {
          onClose();
        }
      }}
    >
      {items.map(({ label, icon: Icon, onSelect, danger, separatorBefore }) => (
        <div key={label} className={separatorBefore ? "session-context-menu__separated" : undefined}>
          <button
            type="button"
            role="menuitem"
            className={danger ? "session-context-menu__danger" : undefined}
            onClick={() => {
              onClose();
              onSelect();
            }}
          >
            <Icon size={12} />
            <span>{label}</span>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
