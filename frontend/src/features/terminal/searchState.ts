export type TerminalSearchState = Record<string, boolean>;

export function setTerminalSearchState(
  state: TerminalSearchState,
  tabId: string,
  open: boolean,
): TerminalSearchState {
  if (Boolean(state[tabId]) === open) return state;
  if (open) return { ...state, [tabId]: true };

  const next = { ...state };
  delete next[tabId];
  return next;
}

export function toggleTerminalSearchOpen(
  state: TerminalSearchState,
  tabId: string,
): TerminalSearchState {
  return setTerminalSearchState(state, tabId, !state[tabId]);
}
