import { render, cleanup, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ComponentProps } from "react";
import AISidebar from "./AISidebar";

afterEach(cleanup);
function props(chatBusy = false): ComponentProps<typeof AISidebar> {
  return {
    tab: {
      id: "tab",
      session: {
        id: "session",
        groupId: "",
        name: "test",
        host: "localhost",
        port: 22,
        username: "test",
        authType: "password",
        privateKeyPath: "",
        credentialRef: "",
      },
      ref: null,
      status: "connected",
      home: "/",
      cwd: "/",
      messages: [{ id: "empty", role: "assistant", text: "" }],
      proposal: null,
      chatBusy,
      executing: false,
      error: "",
    },
    profiles: [],
    profileID: "",
    context: "",
    onProfile: vi.fn(),
    onHide: vi.fn(),
    onSettings: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onClear: vi.fn(),
    onPreview: vi.fn(),
    onClearContext: vi.fn(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    onRevise: vi.fn(async () => {}),
  };
}
test("completed empty reply does not keep spinning", () => {
  const { container } = render(<AISidebar {...props()} />);
  expect(container.querySelector(".message-body .spin")).toBeNull();
  expect(screen.getByText("本次回复未返回文本")).toBeTruthy();
});
test("only the current pending reply spins during a later request", () => {
  const p = props(true);
  p.tab!.messages.push({ id: "next", role: "assistant", text: "" });
  const { container } = render(<AISidebar {...p} />);
  expect(container.querySelectorAll(".message-body .spin")).toHaveLength(1);
});
test("current empty reply spins while waiting for API", () => {
  const { container } = render(<AISidebar {...props(true)} />);
  expect(container.querySelectorAll(".message-body .spin")).toHaveLength(1);
});
