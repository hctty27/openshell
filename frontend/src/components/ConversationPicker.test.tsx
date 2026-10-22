import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
import ConversationPicker from "./ConversationPicker";
const c = {
  id: "one",
  serverKey: "s",
  sessionId: "s",
  title: "Redis",
  titleManual: true,
  summary: "",
  summaryThroughSeq: 0,
  revision: 0,
  createdAt: "",
  updatedAt: "",
};
beforeEach(() => initializeI18n("zh-CN"));
afterEach(cleanup);
test("picker selects by conversation ID and exposes compact management actions", () => {
  const onSelect = vi.fn(),
    onCreate = vi.fn(),
    onRename = vi.fn(),
    onDelete = vi.fn(),
    onLoadMore = vi.fn();
  render(
    <ConversationPicker
      items={[c, { ...c, id: "two" }]}
      selectedID="one"
      busy={false}
      locked={false}
      hasMore={true}
      onSelect={onSelect}
      onCreate={onCreate}
      onRename={onRename}
      onDelete={onDelete}
      onLoadMore={onLoadMore}
    />,
  );
  fireEvent.change(screen.getByLabelText("当前对话"), {
    target: { value: "two" },
  });
  expect(onSelect).toHaveBeenCalledWith("two");
  fireEvent.click(screen.getByTitle("新建对话"));
  expect(onCreate).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByTitle("重命名对话"));
  expect(onRename).toHaveBeenCalledWith("one");
  fireEvent.click(screen.getByTitle("删除对话"));
  expect(onDelete).toHaveBeenCalledWith("one");
  fireEvent.click(screen.getByTitle("加载更多对话"));
  expect(onLoadMore).toHaveBeenCalledOnce();
});
test("busy owner cannot switch, while a peer may open another conversation", () => {
  const props = {
    items: [c],
    selectedID: "one",
    busy: true,
    locked: true,
    hasMore: false,
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onLoadMore: vi.fn(),
  };
  const { rerender } = render(<ConversationPicker {...props} />);
  expect(
    (screen.getByLabelText("当前对话") as HTMLSelectElement).disabled,
  ).toBe(true);
  rerender(<ConversationPicker {...props} busy={false} />);
  expect(
    (screen.getByLabelText("当前对话") as HTMLSelectElement).disabled,
  ).toBe(false);
  expect((screen.getByTitle("删除对话") as HTMLButtonElement).disabled).toBe(
    true,
  );
});
