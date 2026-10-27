import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import App from "./App";
import { api } from "./bridge";
const fixture = vi.hoisted(() => ({
  listeners: {} as Record<string, ((e: any) => void)[]>,
}));
vi.mock("./components/TerminalPane", () => ({ default: () => null }));
vi.mock("./bridge", async () => {
  const actual = await vi.importActual<typeof import("./bridge")>("./bridge");
  const conversation = {
    id: "chat",
    serverKey: "server",
    sessionId: "s",
    title: "Redis",
    titleManual: false,
    summary: "",
    summaryThroughSeq: 0,
    revision: 1,
    createdAt: "",
    updatedAt: "",
  };
  return {
    ...actual,
    desktop: false,
    listen: (name: string, fn: (e: any) => void) => {
      (fixture.listeners[name] ??= []).push(fn);
      return () => {
        fixture.listeners[name] = fixture.listeners[name].filter(
          (f) => f !== fn,
        );
      };
    },
    api: {
      State: vi.fn(async () => ({
        language: "zh-CN",
        sessions: [
          {
            id: "s",
            name: "server",
            host: "example",
            port: 22,
            username: "root",
            authType: "key",
            credentialRef: "saved",
            groupId: "",
            privateKeyPath: "",
          },
        ],
        groups: [],
        profiles: [],
        fontSize: "14",
        activeProfile: "",
        version: "0.1.26",
      })),
      Connect: vi.fn(async (tabId: string, sessionId: string) => ({
        ref: { tabId, sessionId, generation: tabId.length },
        home: "/root",
        conversationId: "chat",
      })),
      ListOperationSteps: vi.fn(async () => []),
      ListConversations: vi.fn(async () => ({
        items: [conversation],
        nextCursor: null,
      })),
      ReadConversation: vi.fn(async () => ({
        conversation,
        messages: [
          {
            id: "old",
            conversationId: "chat",
            seq: 1,
            role: "user",
            content: "saved history",
            status: "completed",
            createdAt: "",
          },
        ],
        beforeSeq: 1,
        hasMore: false,
        run: null,
        eventSeq: 1,
      })),
      CloseTab: vi.fn(async () => {}),
    },
  };
});
afterEach(cleanup);
test("duplicated SSH tabs restore the same conversation and receive shared messages", async () => {
  render(<App />);
  fireEvent.doubleClick(
    await screen.findByRole("button", { name: "选中会话 server" }),
  );
  expect(await screen.findByText("saved history")).toBeTruthy();
  fireEvent.doubleClick(screen.getByTitle("双击复制会话"));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(2));
  const ref = vi.mocked(api.Connect).mock.results[0];
  const connected = await ref.value;
  await act(async () => {
    for (const fn of fixture.listeners["conversation:event"] ?? [])
      fn({
        eventId: "new",
        eventSeq: 2,
        conversationId: "chat",
        serverKey: "server",
        kind: "message",
        revision: 2,
        run: null,
        message: {
          id: "reply",
          conversationId: "chat",
          seq: 2,
          role: "assistant",
          content: "shared reply",
          status: "completed",
          createdAt: "",
        },
      });
  });
  expect(await screen.findByText("shared reply")).toBeTruthy();
  fireEvent.click(screen.getAllByTitle("双击复制会话")[0]);
  expect(screen.getByText("shared reply")).toBeTruthy();
  expect(connected.conversationId).toBe("chat");
});
test("history persistence errors are surfaced to the user", async () => {
  render(<App />);
  await screen.findByRole("button",{name:"选中会话 server"});
  await act(async () => {
    for (const fn of fixture.listeners["conversation:error"] ?? [])
      fn({ conversationId: "chat", error: "disk full" });
  });
  expect(screen.getByRole("alert").textContent).toContain("disk full");
});
