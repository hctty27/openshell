import { expect, test } from "vitest";
import type { AIConversation } from "../../types";
import { collectPromptHistory, emptyPromptHistoryNavigation, navigatePromptHistory } from "./promptHistory";

const conversation = (id: string, messages: AIConversation["messages"], scope: "global" | "terminal" = "global", scopeId = ""): AIConversation => ({
  id, title: id, providerId: "p", modelId: "m", mode: "review", targetNames: [],
  scope, scopeId, messages, updatedAt: id === "recent" ? "2026-11-20T00:00:00Z" : "2026-11-19T00:00:00Z",
});

test("history favors selected conversation and only returns sent user prompts in reverse order", () => {
  const older = conversation("older", [
    { role: "user", content: "older prompt" }, { role: "assistant", content: "older reply" },
  ]);
  const recent = conversation("recent", [
    { role: "user", content: "first\nline" }, { role: "assistant", content: "reply" },
    { role: "user", content: "latest prompt" }, { role: "tool", content: "tool output" },
    { role: "user", content: "   " },
  ]);
  expect(collectPromptHistory([older, recent], "older")).toEqual([
    "older prompt", "latest prompt", "first\nline",
  ]);
  expect(collectPromptHistory([older, recent], "")).toEqual([
    "latest prompt", "first\nline", "older prompt",
  ]);
  expect(collectPromptHistory([older, recent], "", undefined, 2)).toHaveLength(2);
});

test("global and per-terminal prompt histories do not leak into one another", () => {
  const items = [
    conversation("global", [{ role: "user", content: "global prompt" }]),
    conversation("hk", [{ role: "user", content: "hk prompt" }], "terminal", "hk-server"),
    conversation("us", [{ role: "user", content: "us prompt" }], "terminal", "us-server"),
  ];
  expect(collectPromptHistory(items, "", "hk-server")).toEqual(["hk prompt"]);
  expect(collectPromptHistory(items, "", "us-server")).toEqual(["us prompt"]);
  expect(collectPromptHistory(items, "")).toEqual(["global prompt"]);
});

test("up/down navigates past entries and restores unsent draft without changing stored prompts", () => {
  const entries = ["latest", "older"];
  let state = emptyPromptHistoryNavigation();
  const first = navigatePromptHistory(state, "up", "draft", () => entries)!;
  state = first.navigation;
  expect(first.message).toBe("latest");
  const second = navigatePromptHistory(state, "up", first.message, () => [])!;
  state = second.navigation;
  expect(second.message).toBe("older");
  expect(navigatePromptHistory(state, "up", second.message, () => entries)).toBeNull();
  const newer = navigatePromptHistory(state, "down", second.message, () => [])!;
  const restored = navigatePromptHistory(newer.navigation, "down", newer.message, () => [])!;
  expect(restored.message).toBe("draft");
  expect(restored.navigation.index).toBe(-1);
  expect(entries).toEqual(["latest", "older"]);
  expect(navigatePromptHistory(restored.navigation, "down", "draft", () => entries)).toBeNull();
});
