import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import App from "./App";
const fixture = vi.hoisted(() => ({
  listeners: {} as Record<string, (event: any) => void>,
}));
vi.mock("./components/TerminalPane", () => ({ default: () => null }));
vi.mock("./bridge", async () => ({
  ...(await vi.importActual<typeof import("./bridge")>("./bridge")),
  desktop: true,
  listen: (name: string, listener: (event: any) => void) => {
    fixture.listeners[name] = listener;
    return () => {};
  },
  api: {
    State: async () => ({
      language: "zh-CN",
      sessions: [
        {
          id: "server",
          name: "My server",
          host: "host",
          port: 22,
          username: "root",
          authType: "password",
          credentialRef: "saved",
          groupId: "",
          privateKeyPath: "",
        },
      ],
      groups: [],
      profiles: [
        { id: "api", name: "test", model: "model", toolsEnabled: true },
      ],
      fontSize: "14",
      activeProfile: "api",
      version: "test",
    }),
    Connect: async (tabId: string, sessionId: string) => ({
      ref: { tabId, sessionId, generation: 1 },
      home: "/root",
    }),
    StartAutomatic: async (req: any, id: string) => {
      const state = {
        id,
        ref: req.ref,
        status: "running",
        steps: 0,
        roundSteps: 0,
        limit: 10,
        allowChanges: false,
        reason: "",
      };
      fixture.listeners["auto:event"]({
        kind: "thinking",
        state,
        messageId: "reply",
      });
      const failed = {
        ...state,
        status: "error",
        reason:
          'OPENSHELL_ERROR:{"code":"apiHttpStatus","params":{"status":429}}',
      };
      fixture.listeners["auto:event"]({
        kind: "state",
        state: failed,
        messageId: "reply",
      });
      return failed;
    },
    SavePreference: async () => {},
    SetCloseGuardReady: async () => {},
  },
}));
afterEach(cleanup);
test("automatic errors before the first text delta become localized chat snapshots", async () => {
  await act(async () => {
    render(<App />);
  });
  fireEvent.doubleClick(screen.getByText("My server", { exact: true }));
  await waitFor(() => expect(screen.getByText(/SSH 已连接/)).toBeTruthy());
  fireEvent.change(screen.getByLabelText("AI 模式"), {
    target: { value: "auto" },
  });
  fireEvent.change(screen.getByLabelText("发送给 AI"), {
    target: { value: "check" },
  });
  fireEvent.click(screen.getByTitle("发送消息"));
  await waitFor(() =>
    expect(
      document.querySelector(".message.assistant .message-body")?.textContent,
    ).toContain("返回 HTTP 429"),
  );
  expect(
    document.querySelector(".message.assistant .message-body")?.textContent,
  ).not.toContain("OPENSHELL_ERROR:");
});
