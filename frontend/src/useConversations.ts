import { useCallback, useEffect, useRef, useState } from "react";
import { api, listen } from "./bridge";
import { message } from "./i18n/message";
import {
  emptyConversationCache,
  mergeConversationPage,
  reduceConversationEvent,
  type ConversationCache,
} from "./conversations";
import type {
  ConversationCursor,
  ConversationEvent,
  ConversationList,
  ConversationPage,
  Ref,
} from "./types";
export function useConversations() {
  const [cache, setCache] = useState<Record<string, ConversationCache>>({});
  const [selectedByTab, setSelected] = useState<Record<string, string>>({});
  const [serverKeysByTab, setServerKeys] = useState<Record<string, string>>({});
  const [lists, setLists] = useState<Record<string, ConversationList>>({});
  const [loadingByTab, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, unknown>>({});
  const epochs = useRef<Record<string, number>>({}),
    refs = useRef<Record<string, Ref>>({});
  const pending = useRef<Record<string, { id: string; token: number }>>({});
  const selectionVersions = useRef<Record<string, number>>({}),
    eventVersions = useRef<Record<string, number>>({}),
    serverEvents = useRef<Record<string, number>>({});
  const deleted = useRef(new Set<string>());
  const selectedRef = useRef<Record<string, string>>({});
  const cacheRef = useRef(cache),
    listsRef = useRef(lists);
  cacheRef.current = cache;
  listsRef.current = lists;
  const setSelection = useCallback((values: Record<string, string>) => {
    selectedRef.current = { ...selectedRef.current, ...values };
    setSelected(selectedRef.current);
  }, []);
  useEffect(
    () =>
      listen("conversation:event", (e: ConversationEvent) => {
        setCache((old) => ({
          ...old,
          [e.conversationId]: reduceConversationEvent(
            old[e.conversationId] ?? emptyConversationCache(),
            e,
          ),
        }));
        serverEvents.current[e.serverKey] =
          (serverEvents.current[e.serverKey] ?? 0) + 1;
        if (e.kind === "deleted") deleted.current.add(e.conversationId);
        if (
          ["selection", "created", "deleted"].includes(e.kind) &&
          e.selectedByTab
        ) {
          const version = e.selectionRevision ?? e.eventSeq;
          if (version > (selectionVersions.current[e.serverKey] ?? 0)) {
            selectionVersions.current[e.serverKey] = version;
            const accepted: Record<string, string> = {};
            for (const [tab, id] of Object.entries(e.selectedByTab)) {
              const known = refs.current[tab],
                incoming = e.selectedRefs?.[tab];
              if (
                known &&
                incoming &&
                (known.generation !== incoming.generation ||
                  known.sessionId !== incoming.sessionId)
              )
                continue;
              accepted[tab] = id;
              if (pending.current[tab] && pending.current[tab].id !== id) {
                epochs.current[tab] = (epochs.current[tab] ?? 0) + 1;
                delete pending.current[tab];
                setLoading((old) => ({ ...old, [tab]: false }));
                setErrors((old) => ({ ...old, [tab]: null }));
              }
            }
            setSelection(accepted);
            if (e.serverKey && Object.keys(accepted).length) {
              setServerKeys((old) => {
                const next = { ...old };
                for (const tab of Object.keys(accepted)) next[tab] = e.serverKey;
                return next;
              });
            }
          }
        }
        const fresh =
          e.eventSeq > (eventVersions.current[e.conversationId] ?? 0);
        if (fresh) eventVersions.current[e.conversationId] = e.eventSeq;
        if (e.conversation && fresh)
          setLists((old) => {
            const list = old[e.serverKey] ?? { items: [], nextCursor: null };
            const items = list.items.filter((c) => c.id !== e.conversationId);
            if (!deleted.current.has(e.conversationId))
              items.push(e.conversation!);
            items.sort(
              (a, b) =>
                b.updatedAt.localeCompare(a.updatedAt) ||
                b.id.localeCompare(a.id),
            );
            return { ...old, [e.serverKey]: { ...list, items } };
          });
      }),
    [setSelection],
  );
  const accept = useCallback((p: ConversationPage) => {
    if (!p?.conversation) {
      throw message("errors:memoryHistoryUnavailable");
    }
    setCache((old) => ({
      ...old,
      [p.conversation.id]: mergeConversationPage(
        old[p.conversation.id] ?? emptyConversationCache(),
        p,
      ),
    }));
  }, []);
  const list = useCallback(async (ref: Ref, key: string, more = false) => {
    const cursor: ConversationCursor | null = more
      ? (listsRef.current[key]?.nextCursor ?? null)
      : null;
    const version = serverEvents.current[key] ?? 0;
    const result = await api.ListConversations(ref, cursor, 50);
    setLists((old) => {
      const changed = version !== (serverEvents.current[key] ?? 0);
      const items = new Map(
        (more || changed ? (old[key]?.items ?? []) : [])
          .filter((c) => !deleted.current.has(c.id))
          .map((c) => [c.id, c]),
      );
      for (const c of result.items) {
        if (deleted.current.has(c.id)) continue;
        const newer = old[key]?.items.find((i) => i.id === c.id);
        items.set(c.id, newer && newer.revision > c.revision ? newer : c);
      }
      return {
        ...old,
        [key]: {
          items: [...items.values()].sort(
            (a, b) =>
              b.updatedAt.localeCompare(a.updatedAt) ||
              b.id.localeCompare(a.id),
          ),
          nextCursor: result.nextCursor,
        },
      };
    });
  }, []);
  const restore = useCallback(
    async (ref: Ref, id: string, select = false) => {
      // A draft has no database ID and must never be restored as history.
      if (!id) return;
      const token = (epochs.current[ref.tabId] ?? 0) + 1;
      epochs.current[ref.tabId] = token;
      refs.current[ref.tabId] = ref;
      pending.current[ref.tabId] = { id, token };
      setLoading((old) => ({ ...old, [ref.tabId]: true }));
      setErrors((old) => ({ ...old, [ref.tabId]: null }));
      try {
        const p = select
          ? await api.SelectConversation(ref, id)
          : await api.ReadConversation(ref, id, 0, 100);
        if (epochs.current[ref.tabId] !== token || deleted.current.has(id))
          return;
        accept(p);
        setSelection({ [ref.tabId]: id });
        setServerKeys((old) => ({
          ...old,
          [ref.tabId]: p.conversation.serverKey,
        }));
        await list(ref, p.conversation.serverKey);
      } catch (e) {
        if (epochs.current[ref.tabId] === token)
          setErrors((old) => ({ ...old, [ref.tabId]: e }));
        throw e;
      } finally {
        if (epochs.current[ref.tabId] === token) {
          delete pending.current[ref.tabId];
          setLoading((old) => ({ ...old, [ref.tabId]: false }));
        }
      }
    },
    [accept, list, setSelection],
  );
  const draft = async (ref: Ref) => {
    const tab = ref.tabId;
    const token = (epochs.current[tab] ?? 0) + 1;
    epochs.current[tab] = token;
    refs.current[tab] = ref;
    delete pending.current[tab];
    setLoading((old) => ({ ...old, [tab]: true }));
    setErrors((old) => ({ ...old, [tab]: null }));
    try {
      await api.StartConversationDraft(ref);
      if (epochs.current[tab] === token) {
        setSelection({ [tab]: "" });
      }
    } finally {
      if (epochs.current[tab] === token) {
        setLoading((old) => ({ ...old, [tab]: false }));
      }
    }
  };
  const select = async (ref: Ref, id: string) => restore(ref, id, true);
  const rename = async (ref: Ref, id: string, title: string) => {
    await api.RenameConversation(ref, id, title);
  };
  const remove = async (ref: Ref, id: string) => {
    await api.DeleteConversation(ref, id);
  };
  const loadEarlier = async (ref: Ref, id: string) => {
    const before = cacheRef.current[id]?.beforeSeq ?? 0;
    const p = await api.ReadConversation(ref, id, before, 100);
    accept(p);
  };
  const forget = (tabID: string) => {
    epochs.current[tabID] = (epochs.current[tabID] ?? 0) + 1;
    delete refs.current[tabID];
    delete pending.current[tabID];
    const next = { ...selectedRef.current };
    delete next[tabID];
    selectedRef.current = next;
    setSelected(next);
    setServerKeys((old) => {
      const copy = { ...old };
      delete copy[tabID];
      return copy;
    });
  };
  useEffect(() => {
    for (const [tab, id] of Object.entries(selectedByTab)) {
      const ref = refs.current[tab];
      if (!id || !ref || cache[id]?.loaded || loadingByTab[tab] || errors[tab])
        continue;
      void restore(ref, id).catch(() => {});
    }
  }, [selectedByTab, cache, loadingByTab, errors, restore]);
  return {
    cache,
    selectedByTab,
    serverKeysByTab,
    lists,
    loadingByTab,
    errors,
    restore,
    list,
    draft,
    select,
    rename,
    remove,
    loadEarlier,
    forget,
  };
}
