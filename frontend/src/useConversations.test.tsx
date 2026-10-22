import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useConversations } from "./useConversations";
import { api } from "./bridge";
import type { ConversationEvent, ConversationPage } from "./types";
const fixture = vi.hoisted(() => ({
  emit: ((_e: any) => {}) as (e: any) => void,
}));
vi.mock("./bridge", () => ({
  listen: (_name: string, fn: (e: any) => void) => {
    fixture.emit = fn;
    return () => {};
  },
  api: {
    ReadConversation: vi.fn(),
    SelectConversation: vi.fn(),
    ListConversations: vi.fn(),
    StartConversationDraft: vi.fn(async () => {}),
  },
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const ref = { tabId: "tab", sessionId: "s", generation: 1 };
const c = {
  id: "c1",
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
const page = (id = "c1"): ConversationPage => ({
  conversation: { ...c, id },
  messages: [],
  beforeSeq: 0,
  hasMore: false,
  run: null,
  eventSeq: 1,
});
const selection = (
  id: string,
  selectionRevision: number,
): ConversationEvent => ({
  eventId: crypto.randomUUID(),
  eventSeq: selectionRevision,
  selectionRevision,
  serverKey: "server",
  conversationId: id,
  kind: "selection",
  revision: 1,
  run: null,
  conversation: { ...c, id },
  selectedByTab: { tab: id },
  selectedRefs: { tab: ref },
});
test("stale selection snapshots on old stream events cannot roll a tab back", async () => {
  vi.mocked(api.ReadConversation).mockImplementation(async (_ref, id) =>
    page(id),
  );
  vi.mocked(api.ListConversations).mockResolvedValue({
    items: [c],
    nextCursor: null,
  });
  const { result } = renderHook(() => useConversations());
  await act(async () => {
    await result.current.restore(ref, "c1");
  });
  await act(async () => {
    fixture.emit(selection("c2", 2));
    fixture.emit({ ...selection("c1", 1), kind: "stream", eventSeq: 99 });
  });
  expect(result.current.selectedByTab.tab).toBe("c2");
});
test("late first-page lists preserve creations and do not resurrect deletions", async () => {
  vi.mocked(api.ReadConversation).mockImplementation(async (_ref, id) =>
    page(id),
  );
  vi.mocked(api.ListConversations).mockResolvedValue({
    items: [c],
    nextCursor: null,
  });
  const { result } = renderHook(() => useConversations());
  await act(async () => {
    await result.current.restore(ref, "c1");
  });
  let finish!: (v: any) => void;
  vi.mocked(api.ListConversations).mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.list(ref, "server");
  });
  vi.mocked(api.ListConversations).mockResolvedValue({
    items: [{ ...c, id: "c2" }],
    nextCursor: null,
  });
  await act(async () => {
    fixture.emit({ ...selection("c2", 2), kind: "created" });
    fixture.emit({
      ...selection("c1", 3),
      kind: "deleted",
      selectedByTab: { tab: "c2" },
    });
  });
  await act(async () => {
    finish({ items: [c], nextCursor: null });
    await pending;
  });
  expect(result.current.lists.server.items.map((c) => c.id)).toEqual(["c2"]);
});
test("a read response arriving after deletion cannot select the deleted conversation", async () => {
  let finish!: (v: any) => void;
  vi.mocked(api.ReadConversation)
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    )
    .mockResolvedValue(page("c2"));
  vi.mocked(api.ListConversations).mockResolvedValue({
    items: [{ ...c, id: "c2" }],
    nextCursor: null,
  });
  const { result } = renderHook(() => useConversations());
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.restore(ref, "c1");
  });
  await act(async () => {
    fixture.emit({
      ...selection("c1", 2),
      kind: "deleted",
      selectedByTab: { tab: "c2" },
    });
  });
  await act(async () => {
    finish(page());
    await pending;
  });
  await waitFor(() => expect(result.current.selectedByTab.tab).toBe("c2"));
});

test("unsent new drafts only switch the tab and do not create saved conversations", async () => {
  const { result } = renderHook(() => useConversations());
  await act(async () => {
    await result.current.draft(ref);
  });
  expect(result.current.selectedByTab.tab).toBe("");
  expect(api.StartConversationDraft).toHaveBeenCalledTimes(1);
  expect(result.current.lists).toEqual({});
});
