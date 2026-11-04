import type { Tab } from "../../types";

// Primary tabs retain history across reconnects/reopens; duplicate tabs get isolated histories.
export function assignTerminalHistoryScopes(
  tabs: Pick<Tab, "id" | "session">[],
  previous: Record<string, string>,
): Record<string, string> {
  const liveIDs = new Set(tabs.map(tab => tab.id));
  const next = Object.fromEntries(
    Object.entries(previous).filter(([id]) => liveIDs.has(id)),
  );
  for (const tab of tabs) {
    if (next[tab.id]) continue;
    const sessionID = tab.session.id;
    const primaryExists = Object.values(next).includes(sessionID);
    next[tab.id] = primaryExists ? `${sessionID}:${tab.id}` : sessionID;
  }
  return next;
}
