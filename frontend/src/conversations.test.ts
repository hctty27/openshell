import { expect, test } from "vitest";
import {
  reduceConversationEvent,
  mergeConversationPage,
  emptyConversationCache,
  toChatMessages,
} from "./conversations";
import type { ConversationEvent, ConversationPage } from "./types";
const conversation = {
  id: "c",
  serverKey: "server",
  sessionId: "s",
  title: "",
  titleManual: false,
  summary: "",
  summaryThroughSeq: 0,
  revision: 1,
  createdAt: "",
  updatedAt: "",
};
const event = (
  n: number,
  kind = "stream",
  text = "hello",
): ConversationEvent => ({
  eventId: String(n),
  eventSeq: n,
  kind,
  serverKey: "server",
  conversationId: "c",
  revision: 1,
  conversation,
  run: {
    id: "run",
    conversationId: "c",
    kind: "chat",
    status: "running",
    ownerRef: { tabId: "a", sessionId: "s", generation: 9 },
  },
  message: {
    id: "m",
    conversationId: "c",
    seq: 0,
    role: "assistant",
    content: text,
    status: "streaming",
    createdAt: "",
  },
});
test("cumulative stream events are idempotent and out-of-order delivery cannot lose text", () => {
  let cache = emptyConversationCache();
  cache = reduceConversationEvent(cache, event(3, "stream", "hello world"));
  cache = reduceConversationEvent(cache, event(3));
  cache = reduceConversationEvent(cache, event(2));
  expect(cache.messages).toHaveLength(1);
  expect(cache.messages[0].content).toBe("hello world");
  expect(cache.run?.ownerRef.generation).toBe(9);
});
test("a stale snapshot cannot replace newer stream text", () => {
  let cache = reduceConversationEvent(
    emptyConversationCache(),
    event(4, "stream", "complete text"),
  );
  const page: ConversationPage = {
    conversation,
    messages: [{ ...event(1).message!, content: "old" }],
    beforeSeq: 0,
    hasMore: false,
    run: null,
    eventSeq: 1,
  };
  cache = mergeConversationPage(cache, page);
  expect(cache.messages[0].content).toBe("complete text");
  expect(cache.run).not.toBeNull();
});
test("a stale snapshot cannot resurrect a cleared conversation", () => {
  let cache = reduceConversationEvent(emptyConversationCache(), event(1));
  cache = reduceConversationEvent(cache, {
    ...event(5, "cleared"),
    message: undefined,
    revision: 2,
    conversation: { ...conversation, revision: 2 },
    run: null,
  });
  cache = mergeConversationPage(cache, {
    conversation,
    messages: [event(1).message!],
    beforeSeq: 1,
    hasMore: false,
    run: null,
    eventSeq: 1,
  });
  expect(cache.messages).toHaveLength(0);
});
test("pagination merges stable IDs without duplicates and displays tool results", () => {
  let cache = emptyConversationCache();
  const message = {
    ...event(1).message!,
    role: "tool" as const,
    seq: 101,
    status: "completed",
    display: {
      command: "pwd",
      result: {
        status: "completed",
        stdout: "/tmp",
        stderr: "",
        exitCode: 0,
        durationMillis: 1,
        truncated: false,
        reason: "",
      },
    },
  };
  const page: ConversationPage = {
    conversation,
    messages: [message],
    beforeSeq: 101,
    hasMore: true,
    run: null,
    eventSeq: 1,
  };
  cache = mergeConversationPage(cache, page);
  cache = mergeConversationPage(cache, page);
  expect(cache.messages).toHaveLength(1);
  expect(toChatMessages(cache)[0].result?.stdout).toBe("/tmp");
});

test("a committed message delivered after a later run event is still retained", () => {
  let c = reduceConversationEvent(emptyConversationCache(), {
    ...event(3, "run"),
    message: undefined,
    run: null,
  });
  c = reduceConversationEvent(c, {
    ...event(2, "message", "committed"),
    message: {
      ...event(2).message!,
      content: "committed",
      seq: 1,
      status: "completed",
    },
  });
  expect(c.messages.map((m) => m.content)).toEqual(["committed"]);
  expect(c.run).toBeNull();
});
test("deleted conversations reject even equal-revision stale snapshots", () => {
  let c = reduceConversationEvent(emptyConversationCache(), {
    ...event(4, "deleted"),
    message: undefined,
    run: null,
  });
  c = mergeConversationPage(c, {
    conversation,
    messages: [event(1).message!],
    beforeSeq: 1,
    hasMore: false,
    run: null,
    eventSeq: 1,
  });
  expect(c.messages).toHaveLength(0);
  expect(c.deleted).toBe(true);
});
test("unmatched historical tool calls produce a visible unknown result without execution controls", () => {
  const c = emptyConversationCache();
  c.messages = [
    {
      ...event(1).message!,
      role: "assistant",
      content: "",
      seq: 1,
      status: "completed",
      toolCalls: [
        {
          id: "call",
          type: "function",
          function: {
            name: "propose_command",
            arguments: JSON.stringify({
              command: "pwd",
              cwd: "/tmp",
              purpose: "check",
            }),
          },
        },
      ],
    },
  ];
  const messages = toChatMessages(c);
  expect(messages).toHaveLength(1);
  expect(messages[0].role).toBe("result");
  expect(messages[0].result?.status).toBe("unknown");
  expect(messages[0].command).toBe("pwd");
  c.run = event(1).run;
  expect(toChatMessages(c)).toHaveLength(0);
});
test("a delayed clear removes old rows while retaining messages committed after the clear", () => {
  let c = reduceConversationEvent(emptyConversationCache(), {
    ...event(1, "message"),
    message: { ...event(1).message!, id: "old", seq: 1, status: "completed" },
  });
  c = reduceConversationEvent(c, {
    ...event(5, "message"),
    revision: 3,
    message: {
      ...event(5).message!,
      id: "new",
      content: "after clear",
      seq: 1,
      status: "completed",
    },
  });
  c = reduceConversationEvent(c, {
    ...event(3, "cleared"),
    revision: 2,
    message: undefined,
    run: null,
  });
  expect(c.messages.map((m) => m.id)).toEqual(["new"]);
});
