import { beforeEach as beforeLanguageTest } from "vitest";
import { initializeI18n as setTestLanguage } from "../i18n";
beforeLanguageTest(() => setTestLanguage("zh-CN"));
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import QuickCommandBar, { visibleQuickCommands } from "./QuickCommandBar";
import type { QuickCommand, Tab } from "../types";

afterEach(cleanup);

const tab: Tab = {
  id: "tab-1",
  session: {
    id: "ssh-1",
    groupId: "prod",
    name: "prod",
    host: "localhost",
    port: 22,
    username: "root",
    authType: "key",
    privateKeyPath: "",
    credentialRef: "",
  },
  ref: { tabId: "tab-1", sessionId: "ssh-1", generation: 1 },
  status: "connected",
  home: "/root",
  cwd: "/root",
  error: "",
};

const command = (
  id: string,
  scope: QuickCommand["scope"],
  scopeId = "",
): QuickCommand => ({
  id,
  name: id,
  command: "uptime",
  category: "常用",
  scope,
  scopeId,
  confirm: false,
});

test("scopes commands to current session in saved order", () => {
  const commands = [
    command("global", "global"),
    command("other", "session", "ssh-2"),
    command("group", "group", "prod"),
    command("session", "session", "ssh-1"),
    command("wrong-group", "group", "stage"),
  ];
  expect(visibleQuickCommands(commands, tab).map((c) => c.id)).toEqual([
    "global",
    "group",
    "session",
  ]);
  expect(visibleQuickCommands(commands, undefined)).toEqual([]);
});

test("management is the final button in the flat single-row toolbar", () => {
  const manage = vi.fn();
  const run = vi.fn();
  const commands = [command("A", "global"), command("B", "global")];
  const { container } = render(
    <QuickCommandBar tab={tab} commands={commands} onManage={manage} onRun={run} />,
  );
  expect(container.querySelector(".quick-command-list")).toBeTruthy();
  expect(container.querySelector(".quick-command-list.single, .quick-command-list.multi")).toBeNull();
  const buttons = container.querySelectorAll(".quick-command-bar button");
  expect(buttons).toHaveLength(3);
  expect(buttons[0].textContent).toBe("A");
  expect(buttons[1].textContent).toBe("B");
  expect(buttons[2].classList.contains("quick-command-manage")).toBe(true);
  expect(buttons[2].getAttribute("aria-label")).toBe("管理快速命令");
  fireEvent.click(buttons[2]);
  expect(manage).toHaveBeenCalledTimes(1);
  fireEvent.click(buttons[1]);
  expect(run).toHaveBeenCalledWith(commands[1]);
});

test("empty toolbar shows only the add/manage icon", () => {
  const manage = vi.fn();
  const { container } = render(
    <QuickCommandBar tab={tab} commands={[]} onManage={manage} onRun={vi.fn()} />,
  );
  expect(container.querySelector(".quick-command-empty")).toBeNull();
  expect(container.querySelectorAll(".quick-command-bar button")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "管理快速命令" }));
  expect(manage).toHaveBeenCalledTimes(1);
});

test("disconnected commands remain disabled", () => {
  const run = vi.fn();
  render(
    <QuickCommandBar
      tab={{ ...tab, ref: null, status: "disconnected" }}
      commands={[command("A", "global")]}
      onManage={vi.fn()}
      onRun={run}
    />,
  );
  const button = screen.getByRole("button", { name: "A" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(run).not.toHaveBeenCalled();
});

test("overflowing commands scroll horizontally with the mouse wheel", () => {
  const { container } = render(
    <QuickCommandBar tab={tab} commands={[command("A", "global")]}
      onManage={vi.fn()} onRun={vi.fn()} />,
  );
  const list = container.querySelector(".quick-command-list") as HTMLDivElement;
  Object.defineProperty(list, "scrollWidth", { configurable: true, value: 500 });
  Object.defineProperty(list, "clientWidth", { configurable: true, value: 100 });
  fireEvent.wheel(list, { deltaY: 48, deltaX: 0 });
  expect(list.scrollLeft).toBe(48);
});
