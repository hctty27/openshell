import { useEffect, useRef, useState } from "react";
import type { Ref, Tab } from "../../types";

const BACKGROUND_GRACE_MS = 300;
const connectionKey = (ref: Ref) => ref.sessionId + ":" + ref.generation;

// Only server output counts. Ignore terminal control sequences without visible text.
export function hasVisibleTerminalOutput(bytes: Uint8Array): boolean {
  if (!bytes.length) return false;
  const text = new TextDecoder().decode(bytes)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[()][A-Za-z0-9]|[=>])/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  return text.length > 0;
}

interface Options {
  tabs: Tab[];
  visibleTabIDs: string[];
  hasActiveTransfers(ref: Ref): boolean;
}

export function useTabActivity({ tabs, visibleTabIDs, hasActiveTransfers }: Options) {
  const [unread, setUnread] = useState<ReadonlyMap<string, string>>(() => new Map());
  const unreadRef = useRef(new Map<string, string>());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const visible = new Set(visibleTabIDs);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const previousVisible = useRef(visible);
  const hiddenSince = useRef(new Map<string, number>());

  useEffect(() => {
    const now = Date.now();
    for (const id of previousVisible.current) {
      if (!visible.has(id)) hiddenSince.current.set(id, now);
    }
    for (const id of visible) hiddenSince.current.delete(id);
    previousVisible.current = visible;

    const liveConnections = new Map(tabs
      .filter(tab => tab.status === "connected" && tab.ref)
      .map(tab => [tab.id, connectionKey(tab.ref!)]));
    let changed = false;
    for (const [id, key] of unreadRef.current) {
      if (!visible.has(id) && liveConnections.get(id) === key) continue;
      unreadRef.current.delete(id);
      changed = true;
    }
    for (const id of hiddenSince.current.keys()) {
      if (!tabs.some(tab => tab.id === id)) hiddenSince.current.delete(id);
    }
    if (changed) setUnread(new Map(unreadRef.current));
  }, [tabs, visibleTabIDs]);

  const onRemoteOutput = (ref: Ref, bytes: Uint8Array) => {
    if (!ref || visibleRef.current.has(ref.tabId) || unreadRef.current.has(ref.tabId)) return;
    const tab = tabsRef.current.find(tab => tab.id === ref.tabId);
    if (tab?.status !== "connected" || tab.ref?.sessionId !== ref.sessionId ||
        tab.ref.generation !== ref.generation) return;
    const hiddenAt = hiddenSince.current.get(ref.tabId);
    if (hiddenAt !== undefined && Date.now() - hiddenAt < BACKGROUND_GRACE_MS) return;
    if (hasActiveTransfers(ref) || !hasVisibleTerminalOutput(bytes)) return;
    unreadRef.current.set(ref.tabId, connectionKey(ref));
    setUnread(new Map(unreadRef.current));
  };

  return { unreadTabIDs: new Set(unread.keys()), onRemoteOutput };
}
