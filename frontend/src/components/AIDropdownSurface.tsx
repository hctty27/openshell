import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

interface Props {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onDismiss(): void;
  children: ReactNode;
  align?: "start" | "end";
  minWidth?: number;
  matchAnchorWidth?: boolean;
  maxHeight?: number;
  className?: string;
}

const VIEWPORT_GAP = 8;
const ANCHOR_GAP = 6;

export default function AIDropdownSurface({
  open, anchorRef, onDismiss, children, align = "start",
  minWidth = 180, matchAnchorWidth = false, maxHeight = 250, className = "",
}: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const surface = surfaceRef.current;
    if (!anchor || !surface) return;

    const position = () => {
      const rect = anchor.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const preferredWidth = matchAnchorWidth ? rect.width : Math.max(rect.width, minWidth);
      const width = Math.max(0, Math.min(preferredWidth, viewportWidth - VIEWPORT_GAP * 2));
      surface.style.width = `${width}px`;
      surface.style.maxHeight = `${Math.max(0, Math.min(maxHeight, viewportHeight - VIEWPORT_GAP * 2))}px`;

      const height = Math.min(surface.scrollHeight, maxHeight, viewportHeight - VIEWPORT_GAP * 2);
      const below = viewportHeight - rect.bottom - ANCHOR_GAP - VIEWPORT_GAP;
      const above = rect.top - ANCHOR_GAP - VIEWPORT_GAP;
      const placeBelow = below >= height || below >= above;
      const available = Math.max(0, placeBelow ? below : above);
      const visibleHeight = Math.min(height, available);
      surface.style.maxHeight = `${visibleHeight}px`;

      const desiredLeft = align === "end" ? rect.right - width : rect.left;
      const left = Math.max(VIEWPORT_GAP, Math.min(desiredLeft, viewportWidth - width - VIEWPORT_GAP));
      const desiredTop = placeBelow ? rect.bottom + ANCHOR_GAP : rect.top - ANCHOR_GAP - visibleHeight;
      surface.style.left = `${left}px`;
      surface.style.top = `${Math.max(VIEWPORT_GAP, desiredTop)}px`;
      surface.style.visibility = "visible";
    };

    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    observer?.observe(anchor);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      observer?.disconnect();
    };
  }, [open, anchorRef, align, minWidth, matchAnchorWidth, maxHeight]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchorRef.current?.contains(target) && !surfaceRef.current?.contains(target)) {
        onDismiss();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      anchorRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, anchorRef, onDismiss]);

  if (!open) return null;
  return createPortal(
    <div ref={surfaceRef} className={`ai-dropdown-popover ${className}`.trim()}>
      {children}
    </div>,
    document.body,
  );
}
