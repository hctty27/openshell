import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import AISidebar from "./AISidebar";

const events = vi.hoisted(() => new Map<string, (data: any) => void>());

vi.mock("../bridge", () => ({
  api: {
    AIProviders: vi.fn(async () => []),
    AIConversations: vi.fn(async () => []),
  },
  errorText: (value: unknown) => String(value),
  listen: (name: string, callback: (data: any) => void) => {
    events.set(name, callback);
    return () => { events.delete(name); };
  },
}));

afterEach(() => {
  cleanup();
  events.clear();
});

test("AI output follows new chunks near the bottom, but respects manual scrollback", async () => {
  render(<AISidebar tabs={[]} pinned={false} isOpen={true} onTogglePin={vi.fn()} onClose={vi.fn()} />);
  const node = screen.getByRole("complementary", { name: "AI 助手" })
    .querySelector<HTMLElement>(".ai-messages")!;

  Object.defineProperties(node, {
    scrollHeight: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 300 },
  });

  act(() => events.get("ai:delta")?.({ taskId: "test", text: "first" }));
  expect(node.scrollTop).toBe(1200);

  node.scrollTop = 200;
  fireEvent.scroll(node);
  act(() => events.get("ai:delta")?.({ taskId: "test", text: "second" }));
  expect(node.scrollTop).toBe(200);

  node.scrollTop = 900;
  fireEvent.scroll(node);
  act(() => events.get("ai:delta")?.({ taskId: "test", text: "third" }));
  expect(node.scrollTop).toBe(1200);
});

test("AI auto-scroll resumes after reopening while remaining at the bottom", () => {
  const props = { tabs: [], pinned: false, onTogglePin: vi.fn(), onClose: vi.fn() };
  const { rerender } = render(<AISidebar {...props} isOpen={false} />);
  const node = document.querySelector<HTMLElement>(".ai-messages")!;
  Object.defineProperties(node, {
    scrollHeight: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 300 },
  });
  act(() => events.get("ai:delta")?.({ taskId: "test", text: "while hidden" }));
  expect(node.scrollTop).toBe(0);
  rerender(<AISidebar {...props} isOpen={true} />);
  expect(node.scrollTop).toBe(1200);
});
