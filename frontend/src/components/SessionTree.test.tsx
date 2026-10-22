import { beforeEach as beforeLanguageTest } from "vitest";
import { initializeI18n as setTestLanguage } from "../i18n";
beforeLanguageTest(() => setTestLanguage("zh-CN"));
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import SessionTree from "./SessionTree";
import type { Group, Session } from "../types";

const sessions: Session[] = [
  {
    id: "ssh-1",
    groupId: "",
    name: "生产服务器",
    host: "10.0.0.1",
    port: 2222,
    username: "root",
    authType: "password",
    privateKeyPath: "",
    credentialRef: "",
  },
  {
    id: "ssh-2",
    groupId: "g1",
    name: "测试服务器",
    host: "10.0.0.2",
    port: 22,
    username: "deploy",
    authType: "key",
    privateKeyPath: "/home/test/.ssh/id_ed25519",
    credentialRef: "",
  },
];
const groups: Group[] = [{ id: "g1", name: "测试环境" }];
const renderTree = () => {
  const onOpen = vi.fn();
  const onEdit = vi.fn();
  const duplicated = { ...sessions[0], id: "ssh-copy", name: "生产服务器 - 副本" };
  const onDuplicate = vi.fn(async () => duplicated);
  const onCreateInGroup = vi.fn();
  const onDelete = vi.fn();
  const onGroup = vi.fn();
  const onRenameGroup = vi.fn();
  const onDeleteGroup = vi.fn();
  const tree = (currentSessions: Session[]) => (
    <SessionTree
      sessions={currentSessions}
      groups={groups}
      active=""
      onOpen={onOpen}
      onEdit={onEdit}
      onDuplicate={onDuplicate}
      onDelete={onDelete}
      onGroup={onGroup}
      onCreateInGroup={onCreateInGroup}
      onRenameGroup={onRenameGroup}
      onDeleteGroup={onDeleteGroup}
      onSettings={vi.fn()}
    />
  );
  const { rerender } = render(tree(sessions));
  return {
    onOpen,
    onDuplicate,
    duplicated,
    updateSessions: (next: Session[]) => rerender(tree(next)),
    onEdit,
    onCreateInGroup,
    onDelete,
    onGroup,
    onRenameGroup,
    onDeleteGroup,
  };
};

afterEach(cleanup);

test("shows a collapsible session tree with root and groups", () => {
  renderTree();
  expect(screen.getByRole("button", { name: "所有会话" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "选中分组 默认分组" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "选中分组 测试环境" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByTitle("折叠所有会话"));
  expect(
    screen.queryByRole("button", { name: "选中会话 生产服务器" }),
  ).toBeNull();
  fireEvent.click(screen.getByTitle("展开所有会话"));
  expect(
    screen.getByRole("button", { name: "选中会话 生产服务器" }),
  ).toBeTruthy();
});

test("single click selects and shows details without connecting; double click connects", () => {
  const { onOpen, onEdit } = renderTree();
  const item = screen.getByRole("button", { name: "选中会话 生产服务器" });
  fireEvent.click(item);
  const details = within(screen.getByTestId("session-details"));
  expect(details.getByText("10.0.0.1")).toBeTruthy();
  expect(details.getByText("2222")).toBeTruthy();
  expect(details.getByText("root")).toBeTruthy();
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.doubleClick(item);
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith(sessions[0]);
  expect(details.queryByRole("button", { name: "连接" })).toBeNull();
  expect(details.queryByRole("button", { name: "编辑" })).toBeNull();
  fireEvent.contextMenu(item, { clientX: 145, clientY: 80 });
  fireEvent.click(screen.getByRole("menuitem", { name: "编辑会话" }));
  expect(onEdit).toHaveBeenCalledWith(sessions[0]);
});

test("selecting a folder shows folder summary and filtering reveals collapsed matches", () => {
  renderTree();
  fireEvent.click(screen.getByRole("button", { name: "选中分组 测试环境" }));
  const details = within(screen.getByTestId("session-details"));
  expect(details.getAllByText("文件夹").length).toBeGreaterThan(0);
  expect(details.getByText("1")).toBeTruthy();
  expect(details.queryByRole("button", { name: "连接" })).toBeNull();
  fireEvent.click(screen.getByTitle("折叠分组 测试环境"));
  expect(
    screen.queryByRole("button", { name: "选中会话 测试服务器" }),
  ).toBeNull();
  fireEvent.change(screen.getByPlaceholderText("搜索会话…"), {
    target: { value: "10.0.0.2" },
  });
  expect(
    screen.getByRole("button", { name: "选中会话 测试服务器" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "选中会话 生产服务器" }),
  ).toBeNull();
});

test("removes inline counts and three-dot actions from the tree", () => {
  renderTree();
  expect(document.querySelector(".tree-root > small")).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "选中分组 测试环境" })
      .querySelector("small"),
  ).toBeNull();
  expect(screen.queryByTitle("管理分组 测试环境")).toBeNull();
  expect(screen.queryByTitle("管理 生产服务器")).toBeNull();
  expect(document.querySelector(".row-menu")).toBeNull();
});

test("right-clicking a folder opens a floating menu and preselects that folder", () => {
  const { onCreateInGroup, onRenameGroup, onDeleteGroup } = renderTree();
  const folder = screen.getByRole("button", { name: "选中分组 测试环境" });
  fireEvent.contextMenu(folder, { clientX: 150, clientY: 95 });
  const menu = screen.getByRole("menu", { name: "会话操作" });
  expect(menu.parentElement).toBe(document.body);
  expect(menu.style.position).not.toBe("absolute");
  expect(
    within(screen.getByTestId("session-details")).getAllByText("测试环境")
      .length,
  ).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("menuitem", { name: "新建 SSH 会话" }));
  expect(onCreateInGroup).toHaveBeenCalledWith("g1");
  expect(screen.queryByRole("menu")).toBeNull();

  fireEvent.contextMenu(folder, { clientX: 150, clientY: 95 });
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
  expect(onRenameGroup).toHaveBeenCalledWith(groups[0]);
  fireEvent.contextMenu(folder);
  fireEvent.click(screen.getByRole("menuitem", { name: "删除分组" }));
  expect(onDeleteGroup).toHaveBeenCalledWith(groups[0]);
});

test("default group cannot be deleted and session menu preserves actions", () => {
  const { onOpen, onDelete } = renderTree();
  fireEvent.contextMenu(
    screen.getByRole("button", { name: "选中分组 默认分组" }),
  );
  expect(screen.getByRole("menuitem", { name: "新建 SSH 会话" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "删除分组" })).toBeNull();

  const item = screen.getByRole("button", { name: "选中会话 生产服务器" });
  fireEvent.contextMenu(item, { clientX: 65, clientY: 60 });
  expect(screen.getByRole("menuitem", { name: "连接" })).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "连接" }));
  expect(onOpen).toHaveBeenCalledWith(sessions[0]);
  fireEvent.contextMenu(item);
  fireEvent.click(screen.getByRole("menuitem", { name: "删除会话" }));
  expect(onDelete).toHaveBeenCalledWith(sessions[0]);
});

test("session context menu duplicates without connecting and selects the new session", async () => {
  const { onDuplicate, onOpen, duplicated, updateSessions } = renderTree();
  const item = screen.getByRole("button", { name: "选中会话 生产服务器" });
  fireEvent.contextMenu(item);
  expect(screen.getByRole("menuitem", { name: "复制会话" })).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "复制会话" }));
  expect(onDuplicate).toHaveBeenCalledOnce();
  expect(onDuplicate).toHaveBeenCalledWith(sessions[0]);
  expect(onOpen).not.toHaveBeenCalled();
  await waitFor(() => {
    updateSessions([...sessions, duplicated]);
    expect(screen.getByRole("button", { name: "选中会话 生产服务器 - 副本" }).getAttribute("aria-pressed")).toBe("true");
  });
  expect(within(screen.getByTestId("session-details")).getAllByText(duplicated.name).length).toBeGreaterThan(0);
});

test("Shift+F10 opens a floating menu and Escape returns focus to the folder", () => {
  renderTree();
  const folder = screen.getByRole("button", { name: "选中分组 测试环境" });
  folder.focus();
  fireEvent.keyDown(folder, { key: "F10", shiftKey: true });
  const menu = screen.getByRole("menu");
  expect(menu.parentElement).toBe(document.body);
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "重命名" }),
  );
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(folder);
});

test("floating menu dismisses on outside click and flips away from viewport edges", () => {
  renderTree();
  const item = screen.getByRole("button", { name: "选中会话 生产服务器" });
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("session-context-menu")) {
        return {
          width: 132,
          height: 86,
          top: 0,
          left: 0,
          right: 132,
          bottom: 86,
          x: 0,
          y: 0,
          toJSON: () => {},
        };
      }
      return {
        width: 200,
        height: 26,
        top: 0,
        left: 0,
        right: 200,
        bottom: 26,
        x: 0,
        y: 0,
        toJSON: () => {},
      };
    });
  fireEvent.contextMenu(item, {
    clientX: window.innerWidth - 2,
    clientY: window.innerHeight - 2,
  });
  const menu = screen.getByRole("menu") as HTMLDivElement;
  expect(Number.parseInt(menu.style.left)).toBeLessThanOrEqual(
    window.innerWidth - 140,
  );
  expect(Number.parseInt(menu.style.top)).toBeLessThanOrEqual(
    window.innerHeight - 94,
  );
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
  rect.mockRestore();
});
