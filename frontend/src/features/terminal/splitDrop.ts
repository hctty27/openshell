export const TAB_DRAG_MIME = "application/x-openshell-tab";

export type SplitDropZone = "left" | "right" | "top" | "bottom";
export type SplitDirection = "columns" | "rows";
export type SplitDropMode = "edge" | "smart";
export interface SplitDropIntent { zone: SplitDropZone; mode: SplitDropMode }

interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Edge bands use only the outer 28% of a pane. The center is a forgiving
 * smart-drop region; hysteresis prevents tiny pointer movements from
 * repeatedly switching an edge preview.
 */
export function getSplitDropIntent(
  bounds: Bounds, x: number, y: number, previous?: SplitDropIntent,
): SplitDropIntent {
  if (bounds.width <= 0 || bounds.height <= 0) return { zone: "right", mode: "smart" };
  const px = Math.min(1, Math.max(0, (x - bounds.left) / bounds.width));
  const py = Math.min(1, Math.max(0, (y - bounds.top) / bounds.height));
  const candidates: { zone: SplitDropZone; distance: number }[] = [
    { zone: "left", distance: px },
    { zone: "right", distance: 1 - px },
    { zone: "top", distance: py },
    { zone: "bottom", distance: 1 - py },
  ];
  const closest = candidates.reduce((best, item) => item.distance < best.distance ? item : best);
  const existing = candidates.find(item => item.zone === previous?.zone);
  if (previous?.mode === "edge" && existing &&
    existing.distance <= 0.32 && existing.distance <= closest.distance + 0.05)
    return previous;
  if (closest.distance < 0.28) return { zone: closest.zone, mode: "edge" };
  return { zone: bounds.width >= bounds.height ? "right" : "bottom", mode: "smart" };
}

// Retain this API for first-stage layout helpers and existing callers.
export function getSplitDropZone(bounds: Bounds, x: number, y: number): SplitDropZone {
  return getSplitDropIntent(bounds, x, y).zone;
}

export function splitLayoutFromDrop(sourceID: string, targetID: string, zone: SplitDropZone) {
  if (!sourceID || !targetID || sourceID === targetID) return null;
  const before = zone === "left" || zone === "top";
  return {
    pair: (before ? [sourceID, targetID] : [targetID, sourceID]) as [string, string],
    direction: (zone === "left" || zone === "right" ? "columns" : "rows") as SplitDirection,
  };
}
