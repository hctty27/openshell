import { beforeEach as beforeLanguageTest } from "vitest";
import { initializeI18n as setTestLanguage } from "../i18n";
beforeLanguageTest(() => setTestLanguage("zh-CN"));
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import SessionPicker from "./SessionPicker";
import type { Session } from "../types";

const us: Session = {
  id: "us-id",
  groupId: "",
  name: "us",
  host: "38.65.94.188",
  port: 22,
  username: "root",
  authType: "key",
  privateKeyPath: "",
  credentialRef: "saved",
};
const hk: Session = {
  ...us,
  id: "hk-id",
  groupId: "production",
  name: "hk-server",
  host: "10.10.10.2",
};

function setup() {
  const onConnect = vi.fn();
  const onOpenNewTab = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const onNew = vi.fn();
  const onNewGroup = vi.fn();
  const onClose = vi.fn();
  render(
    <SessionPicker
      sessions={[us, hk]}
      groups={[{ id: "production", name: "生产环境" }]}
      openedSessionIds={["us-id"]}
      onConnect={onConnect}
      onOpenNewTab={onOpenNewTab}
      onEdit={onEdit}
      onDelete={onDelete}
      onNew={onNew}
      onNewGroup={onNewGroup}
      onClose={onClose}
    />,
  );
  return {
    onConnect,
    onOpenNewTab,
    onEdit,
    onDelete,
    onNew,
    onNewGroup,
    onClose,
  };
}

afterEach(cleanup);

test("single-click selects a session; double-click connects it", () => {
  const { onConnect } = setup();
  const row = screen.getByRole("button", { name: "选择会话 us" });
  fireEvent.click(row);
  expect(row.getAttribute("aria-pressed")).toBe("true");
  expect(onConnect).not.toHaveBeenCalled();
  fireEvent.doubleClick(row);
  expect(onConnect).toHaveBeenCalledWith(us);
});

test("Enter connects the focused session and search filters across folders", () => {
  const { onConnect } = setup();
  fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), {
    target: { value: "10.10.10" },
  });
  expect(screen.queryByRole("button", { name: "选择会话 us" })).toBeNull();
  const row = screen.getByRole("button", { name: "选择会话 hk-server" });
  fireEvent.keyDown(row, { key: "Enter" });
  expect(onConnect).toHaveBeenCalledWith(hk);
});

test("clicking a folder filters the list without connecting", () => {
  const { onConnect } = setup();
  fireEvent.click(screen.getByRole("button", { name: /生产环境/ }));
  expect(screen.queryByRole("button", { name: "选择会话 us" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "选择会话 hk-server" }),
  ).toBeTruthy();
  expect(onConnect).not.toHaveBeenCalled();
});

test("supports footer actions, context actions and dismissing", () => {
  const { onNew, onOpenNewTab, onDelete, onClose, onNewGroup } = setup();
  fireEvent.click(screen.getByRole("button", { name: "新建" }));
  expect(onNew).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "新建分组" }));
  expect(onNewGroup).toHaveBeenCalledOnce();
  fireEvent.contextMenu(screen.getByRole("button", { name: "选择会话 us" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /在新标签中打开/ }));
  expect(onOpenNewTab).toHaveBeenCalledWith(us);
  fireEvent.contextMenu(
    screen.getByRole("button", { name: "选择会话 hk-server" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  expect(onDelete).toHaveBeenCalledWith(hk);
  fireEvent.click(screen.getByRole("button", { name: "关闭会话管理" }));
  expect(onClose).toHaveBeenCalledOnce();
});

test("selected row can connect with the bottom button", () => {
  const { onConnect } = setup();
  const connect = screen.getByRole("button", { name: "连接" });
  expect((connect as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "选择会话 us" }));
  expect((connect as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(connect);
  expect(onConnect).toHaveBeenCalledWith(us);
});
