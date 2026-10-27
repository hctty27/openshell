export interface HorizontalTabBounds {
  id: string;
  left: number;
  width: number;
}

export function tabInsertionIndex(
  tabs: HorizontalTabBounds[], draggedID: string, pointerX: number,
): number {
  return tabs.filter(tab => tab.id !== draggedID)
    .filter(tab => pointerX >= tab.left + tab.width / 2).length;
}

export function reorderFromInsertion(
  ids: string[], draggedID: string, insertionIndex: number,
): { targetID: string; placement: "before" | "after" } | null {
  const others = ids.filter(id => id !== draggedID);
  if (!ids.includes(draggedID) || others.length === 0) return null;
  const index = Math.max(0, Math.min(others.length, insertionIndex));
  return index < others.length
    ? { targetID: others[index], placement: "before" }
    : { targetID: others[others.length - 1], placement: "after" };
}

export function tabEdgeScrollSpeed(
  pointerX: number, left: number, right: number, edge = 40,
): number {
  if (pointerX < left || pointerX > right) return 0;
  if (pointerX < left + edge) return -Math.min(1, (left + edge - pointerX) / edge);
  if (pointerX > right - edge) return Math.min(1, (pointerX - (right - edge)) / edge);
  return 0;
}
