import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import SessionTree from "./SessionTree";
import type { Group, Session } from "../types";

const sessions: Session[] = [
  {
    id: "ssh-1", groupId: "", name: "生产服务器", host: "10.0.0.1",
    port: 2222, username: "root", authType: "password",
    privateKeyPath: "", credentialRef: "",
  },
  {
    id: "ssh-2", groupId: "g1", name: "测试服务器", host: "10.0.0.2",
    port: 22, username: "deploy", authType: "key",
    privateKeyPath: "/home/test/.ssh/id_ed25519", credentialRef: "",
  },
];
const groups: Group[] = [{ id: "g1", name: "测试环境" }];
const renderTree = () => {
  const onOpen = vi.fn();
  const onEdit = vi.fn();
  render(
    <SessionTree
      sessions={sessions} groups={groups} active=""
      onOpen={onOpen} onEdit={onEdit} onDelete={vi.fn()} onGroup={vi.fn()}
      onRenameGroup={vi.fn()} onDeleteGroup={vi.fn()} onSettings={vi.fn()}
    />,
  );
  return { onOpen, onEdit };
};

afterEach(cleanup);

test("shows a collapsible session tree with root and groups", () => {
  renderTree();
  expect(screen.getByRole("button", { name: "所有会话" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "选中分组 默认分组" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "选中分组 测试环境" })).toBeTruthy();
  fireEvent.click(screen.getByTitle("折叠所有会话"));
  expect(screen.queryByRole("button", { name: "选中会话 生产服务器" })).toBeNull();
  fireEvent.click(screen.getByTitle("展开所有会话"));
  expect(screen.getByRole("button", { name: "选中会话 生产服务器" })).toBeTruthy();
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
  fireEvent.click(screen.getByTitle("管理 生产服务器"));
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
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
  expect(screen.queryByRole("button", { name: "选中会话 测试服务器" })).toBeNull();
  fireEvent.change(screen.getByPlaceholderText("搜索会话…"), {
    target: { value: "10.0.0.2" },
  });
  expect(screen.getByRole("button", { name: "选中会话 测试服务器" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "选中会话 生产服务器" })).toBeNull();
});
