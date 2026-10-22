import type {
  Conversation,
  ConversationMessage,
  ConversationPage,
  ConversationEvent,
  ConversationRun,
  ChatMessage,
} from "./types";
export interface ConversationCache {
  conversation?: Conversation;
  messages: ConversationMessage[];
  run: ConversationRun | null;
  revision: number;
  eventSeq: number;
  resetRevision: number;
  messageSeq: Record<string, number>;
  messageRevision: Record<string, number>;
  pageRevision: number;
  deleted: boolean;
  hasMore: boolean;
  beforeSeq: number;
  status: string;
  loaded: boolean;
  loading: boolean;
  error: unknown;
}
export const emptyConversationCache = (): ConversationCache => ({
  messages: [],
  run: null,
  revision: 0,
  eventSeq: 0,
  resetRevision: 0,
  messageSeq: {},
  messageRevision: {},
  pageRevision: 0,
  deleted: false,
  hasMore: false,
  beforeSeq: 0,
  status: "",
  loaded: false,
  loading: false,
  error: null,
});
function mergeMessages(
  old: ConversationMessage[],
  incoming: ConversationMessage[],
  overwrite = true,
) {
  const map = new Map(old.map((m) => [m.id, m]));
  for (const m of incoming) if (overwrite || !map.has(m.id)) map.set(m.id, m);
  return [...map.values()].sort(
    (a, b) =>
      (a.seq || Number.MAX_SAFE_INTEGER) - (b.seq || Number.MAX_SAFE_INTEGER),
  );
}
export function reduceConversationEvent(
  cache: ConversationCache,
  e: ConversationEvent,
): ConversationCache {
  if (cache.deleted || e.revision < cache.resetRevision) return cache;
  const newer = e.eventSeq > cache.eventSeq && e.revision >= cache.revision;
  const reset = e.kind === "cleared" || e.kind === "deleted";
  let messages = cache.messages;
  let messageSeq = { ...cache.messageSeq },
    messageRevision = { ...cache.messageRevision };
  if (reset) {
    messages =
      e.kind === "deleted"
        ? []
        : messages.filter(
            (m) =>
              (messageRevision[m.id] ?? 0) >= e.revision &&
              (messageSeq[m.id] ?? 0) > e.eventSeq,
          );
    const retained = new Set(messages.map((m) => m.id));
    messageSeq = Object.fromEntries(
      Object.entries(messageSeq).filter(([id]) => retained.has(id)),
    );
    messageRevision = Object.fromEntries(
      Object.entries(messageRevision).filter(([id]) => retained.has(id)),
    );
  }
  if (!reset && e.message && e.eventSeq > (messageSeq[e.message.id] ?? 0)) {
    messages = mergeMessages(messages, [e.message]);
    messageSeq[e.message.id] = e.eventSeq;
    messageRevision[e.message.id] = e.revision;
  }
  const preservePage = reset && cache.pageRevision > e.revision;
  return {
    ...cache,
    messages,
    messageSeq,
    messageRevision,
    conversation: newer
      ? (e.conversation ?? cache.conversation)
      : cache.conversation,
    revision: Math.max(cache.revision, e.revision),
    eventSeq: Math.max(cache.eventSeq, e.eventSeq),
    run: newer ? e.run : cache.run,
    resetRevision: reset ? e.revision : cache.resetRevision,
    deleted: e.kind === "deleted",
    loaded: reset ? true : cache.loaded,
    hasMore: reset && !preservePage ? false : cache.hasMore,
    beforeSeq: reset && !preservePage ? 0 : cache.beforeSeq,
    status:
      newer &&
      ["summary", "recent", "summarizing", "full"].includes(e.status ?? "")
        ? e.status!
        : cache.status,
  };
}
export function mergeConversationPage(
  cache: ConversationCache,
  p: ConversationPage,
): ConversationCache {
  if (cache.deleted || p.conversation.revision < cache.resetRevision)
    return cache;
  const newer =
    p.eventSeq >= cache.eventSeq && p.conversation.revision >= cache.revision;
  let messages = cache.messages;
  const messageSeq = { ...cache.messageSeq },
    messageRevision = { ...cache.messageRevision };
  for (const m of p.messages) {
    const exists = messages.some((old) => old.id === m.id);
    if (!exists || (newer && (messageSeq[m.id] ?? 0) <= p.eventSeq)) {
      messages = mergeMessages(messages, [m]);
      messageSeq[m.id] = p.eventSeq;
      messageRevision[m.id] = p.conversation.revision;
    }
  }
  return {
    ...cache,
    messages,
    messageSeq,
    messageRevision,
    pageRevision: Math.max(cache.pageRevision, p.conversation.revision),
    conversation: newer
      ? p.conversation
      : (cache.conversation ?? p.conversation),
    run: newer ? p.run : cache.run,
    eventSeq: Math.max(cache.eventSeq, p.eventSeq),
    revision: Math.max(cache.revision, p.conversation.revision),
    beforeSeq:
      cache.beforeSeq && p.beforeSeq
        ? Math.min(cache.beforeSeq, p.beforeSeq)
        : p.beforeSeq,
    hasMore: p.hasMore,
    loaded: true,
    loading: false,
    error: null,
    status: cache.status || (p.conversation.summary ? "summary" : "restored"),
  };
}
export function toChatMessages(cache: ConversationCache): ChatMessage[] {
  const out: ChatMessage[] = [];
  cache.messages.forEach((m, index) => {
    if (m.content || m.role !== "assistant" || !m.toolCalls?.length)
      out.push({
        id: m.id,
        role: m.role === "tool" ? "result" : m.role,
        text: m.content,
        incomplete: m.status === "incomplete",
        result: m.display?.result,
        command: m.display?.command,
      });
    if (m.role !== "assistant" || !m.toolCalls?.length) return;
    for (const raw of m.toolCalls) {
      const call = raw as { id?: string; function?: { arguments?: string } };
      if (!call?.id) continue;
      const later = cache.messages.slice(index + 1);
      const nextTurn = later.findIndex(
        (row) => row.role === "user" || row.role === "assistant",
      );
      const results = nextTurn < 0 ? later : later.slice(0, nextTurn);
      if (
        results.some((row) => row.role === "tool" && row.toolCallId === call.id)
      )
        continue;
      if (cache.run && index === cache.messages.length - 1) continue;
      let command = "";
      try {
        const args = JSON.parse(call.function?.arguments ?? "{}");
        if (typeof args.command === "string") command = args.command;
      } catch {}
      out.push({
        id: `unknown-${m.id}-${call.id}`,
        role: "result",
        text: "",
        command,
        result: {
          status: "unknown",
          stdout: "",
          stderr: "",
          exitCode: null,
          durationMillis: 0,
          truncated: false,
          reason:
            "Historical execution result was not saved. This command will not be retried automatically.",
          reasonCode: "historicalResultUnknown",
        },
      });
    }
  });
  return out;
}
