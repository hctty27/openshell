import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
import ConversationPicker from "./ConversationPicker";

const conversation = {
  id: "one",
  serverKey: "server",
  sessionId: "s",
  title: "Redis",
  titleManual: true,
  summary: "",
  summaryThroughSeq: 0,
  revision: 0,
  createdAt: "",
  updatedAt: "2026-10-22T02:00:00Z",
};
const handlers = () => ({
  onSelect: vi.fn(),
  onCreate: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onLoadMore: vi.fn(),
});
beforeEach(() => initializeI18n("zh-CN"));
afterEach(cleanup);

test("compact picker keeps time in dropdown and manages each historical conversation", () => {
  const events = handlers();
  render(
    <ConversationPicker
      items={[conversation, { ...conversation, id: "two", title: "CPU" }]}
      selectedID="one"
      busy={false}
      locked={false}
      hasMore
      {...events}
    />,
  );
  const trigger = screen.getByRole("button", { name: "当前对话" });
  expect(trigger.textContent).toBe("Redis");
  fireEvent.click(trigger);
  expect(screen.getByRole("listbox")).toBeTruthy();
  const item = screen.getByRole("option", { name: /Redis/ });
  const line = item.querySelector(".conversation-entry-text");
  expect(line?.querySelector("span")?.textContent).toBe("Redis");
  expect(line?.querySelector("small")?.textContent).toContain("10/22");
  expect(line?.children.length).toBe(2);
  fireEvent.contextMenu(screen.getByRole("option", { name: /CPU/ }));
  fireEvent.click(screen.getAllByTitle("重命名对话")[1]);
  expect(events.onRename).toHaveBeenCalledWith("two");
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { name: /CPU/ }));
  expect(events.onSelect).toHaveBeenCalledWith("two");
  fireEvent.click(screen.getByTitle("新建对话"));
  expect(events.onCreate).toHaveBeenCalledOnce();
  fireEvent.click(trigger);
  fireEvent.click(screen.getAllByTitle("删除对话")[0]);
  expect(events.onDelete).toHaveBeenCalledWith("one");
  fireEvent.click(trigger);
  fireEvent.click(screen.getByText("加载更多对话"));
  expect(events.onLoadMore).toHaveBeenCalledOnce();
});

test("new empty draft is not repeatedly created and a locked owner cannot switch", () => {
  const events = handlers();
  const { rerender } = render(
    <ConversationPicker
      items={[conversation]}
      selectedID=""
      busy={false}
      locked={false}
      hasMore={false}
      {...events}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "新建对话" }));
  expect(events.onCreate).not.toHaveBeenCalled();
  rerender(
    <ConversationPicker
      items={[conversation]}
      selectedID="one"
      busy
      locked
      hasMore={false}
      {...events}
    />,
  );
  expect((screen.getByRole("button", { name: "当前对话" }) as HTMLButtonElement).disabled).toBe(true);
  rerender(
    <ConversationPicker
      items={[conversation]}
      selectedID="one"
      busy={false}
      locked
      hasMore={false}
      {...events}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "当前对话" }));
  expect((screen.getByTitle("删除对话") as HTMLButtonElement).disabled).toBe(true);
});
