import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import QuickCommandBar, { visibleQuickCommands } from "./QuickCommandBar";
import type { QuickCommand, Tab } from "../types";

afterEach(cleanup);
const tab: Tab = {
  id: "tab-1",
  session: {
    id: "ssh-1", groupId: "prod", name: "prod", host: "localhost",
    port: 22, username: "root", authType: "key", privateKeyPath: "",
    credentialRef: "",
  },
  ref: { tabId: "tab-1", sessionId: "ssh-1", generation: 1 },
  status: "connected", home: "/root", cwd: "/root", messages: [],
  proposal: null, chatBusy: false, executing: false, error: "",
};
const command = (id: string, scope: QuickCommand["scope"], scopeId = ""): QuickCommand => ({
  id, name: id, command: "uptime", category: "常用", scope, scopeId,
  mode: "run", confirm: false,
});

test("scopes commands to current session in saved order", () => {
  const commands = [
    command("global", "global"),
    command("other", "session", "ssh-2"),
    command("group", "group", "prod"),
    command("session", "session", "ssh-1"),
    command("wrong-group", "group", "stage"),
  ];
  expect(visibleQuickCommands(commands, tab).map((c) => c.id))
    .toEqual(["global", "group", "session"]);
  expect(visibleQuickCommands(commands, undefined)).toEqual([]);
});

test("management is the first button; command buttons send selected command", () => {
  const manage = vi.fn(), run = vi.fn();
  const commands = [command("A", "global"), command("B", "global")];
  const { container } = render(
    <QuickCommandBar tab={tab} commands={commands} layout="single" onManage={manage} onRun={run}/>,
  );
  expect(container.querySelector(".quick-command-list.single")).toBeTruthy();
  const buttons = container.querySelectorAll("button");
  expect(buttons[0].textContent).toBe("管理");
  expect(buttons[1].textContent).toBe("A");
  expect(buttons[2].textContent).toBe("B");
  fireEvent.click(buttons[0]);
  expect(manage).toHaveBeenCalledTimes(1);
  fireEvent.click(buttons[2]);
  expect(run).toHaveBeenCalledWith(commands[1]);
});

test("multi-line setting changes layout and disconnected commands cannot run", () => {
  const run = vi.fn();
  const { container } = render(
    <QuickCommandBar tab={{ ...tab, status: "disconnected" }} commands={[command("A", "global")]}
      layout="multi" onManage={vi.fn()} onRun={run}/>,
  );
  expect(container.querySelector(".quick-command-list.multi")).toBeTruthy();
  expect(screen.getByRole("button", { name: "A" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "A" }));
  expect(run).not.toHaveBeenCalled();
});
