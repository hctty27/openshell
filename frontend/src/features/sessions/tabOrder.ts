export type TabPlacement = "before" | "after";

/** Move an existing tab without replacing its SSH reference or component key. */
export function reorderTabs<T extends { id: string }>(
  tabs: T[], sourceID: string, targetID: string, placement: TabPlacement,
): T[] {
  const sourceIndex = tabs.findIndex(tab => tab.id === sourceID);
  if (sourceIndex < 0 || sourceID === targetID || !tabs.some(tab => tab.id === targetID))
    return tabs;

  const next = tabs.filter(tab => tab.id !== sourceID);
  const targetIndex = next.findIndex(tab => tab.id === targetID);
  const insertion = targetIndex + (placement === "after" ? 1 : 0);
  if (insertion === sourceIndex) return tabs;
  next.splice(insertion, 0, tabs[sourceIndex]);
  return next;
}
