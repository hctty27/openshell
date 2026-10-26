export const TAB_DRAG_MIME = "application/x-openshell-tab";

export type SplitDropZone = "left" | "right" | "top" | "bottom";
export type SplitDirection = "columns" | "rows";

interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function getSplitDropZone(bounds: Bounds, x: number, y: number): SplitDropZone {
  const horizontal = (x - bounds.left) / bounds.width;
  const vertical = (y - bounds.top) / bounds.height;
  const distances: [SplitDropZone, number][] = [
    ["left", horizontal],
    ["right", 1 - horizontal],
    ["top", vertical],
    ["bottom", 1 - vertical],
  ];
  return distances.reduce((closest, next) => next[1] < closest[1] ? next : closest)[0];
}

export function splitLayoutFromDrop(sourceID: string, targetID: string, zone: SplitDropZone) {
  if (!sourceID || !targetID || sourceID === targetID) return null;
  const before = zone === "left" || zone === "top";
  return {
    pair: (before ? [sourceID, targetID] : [targetID, sourceID]) as [string, string],
    direction: (zone === "left" || zone === "right" ? "columns" : "rows") as SplitDirection,
  };
}
