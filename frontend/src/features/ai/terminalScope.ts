import type { Tab } from "../../types";

// Terminal AI history is owned by the saved session, even when its tabs are duplicated.
// Live terminal state (cwd, environment, PTY) remains independent per tab.
export function assignTerminalHistoryScopes(
  tabs: Pick<Tab, "id" | "session">[],
  _previous: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(tabs.map(tab => [tab.id, tab.session.id]));
}
