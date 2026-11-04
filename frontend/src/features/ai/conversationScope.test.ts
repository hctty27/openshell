import { expect, test } from "vitest";
import type { AIConversation, Session } from "../../types";
import { belongsToConversationScope } from "./conversationScope";
import { assignTerminalHistoryScopes } from "./terminalScope";

const item = (fields: Partial<AIConversation>): AIConversation => ({
  id: "c", title: "task", providerId: "p", modelId: "m", mode: "review",
  targetNames: [], messages: [], updatedAt: "", ...fields,
});

test("global and terminal histories never cross surfaces", () => {
  expect(belongsToConversationScope(item({ scope: "global" }))).toBe(true);
  expect(belongsToConversationScope(item({ scope: "global" }), "server-1")).toBe(false);
  expect(belongsToConversationScope(item({ scope: "terminal", scopeId: "server-1" }), "server-1")).toBe(true);
  expect(belongsToConversationScope(item({ scope: "terminal", scopeId: "server-1" }), "server-2")).toBe(false);
  expect(belongsToConversationScope(item({ scope: "terminal", scopeId: "server-1" }))).toBe(false);
});

test("legacy independent histories stay global; legacy terminal histories remain session-scoped", () => {
  expect(belongsToConversationScope(item({ execution: "independent" }))).toBe(true);
  expect(belongsToConversationScope(item({ execution: "terminal", targetSessionIds: ["server-1"] }), "server-1")).toBe(true);
  expect(belongsToConversationScope(item({ execution: "terminal", targetSessionIds: ["server-1"] }))).toBe(false);
  expect(belongsToConversationScope(item({ execution: "terminal", targetSessionIds: ["server-1"] }), "server-2")).toBe(false);
});

test("reconnects and duplicated tabs share the saved SSH session history", () => {
  const session = { id: "server-1" } as Session;
  const first = assignTerminalHistoryScopes([{ id: "a", session }], {});
  const second = assignTerminalHistoryScopes([{ id: "a", session }, { id: "b", session }], first);
  expect(second.a).toBe("server-1");
  expect(second.b).toBe("server-1");
  expect(assignTerminalHistoryScopes([{ id: "b", session }], second).b).toBe("server-1");
  expect(assignTerminalHistoryScopes([{ id: "c", session }], {}).c).toBe("server-1");
});

test("old duplicate-tab conversations remain visible under the parent session", () => {
  const duplicate = item({
    scope: "terminal", scopeId: "server-1:tab-b",
    targetSessionIds: ["server-1"],
  });
  expect(belongsToConversationScope(duplicate, "server-1")).toBe(true);
  expect(belongsToConversationScope(duplicate, "server-2")).toBe(false);
  expect(belongsToConversationScope(duplicate)).toBe(false);
});
