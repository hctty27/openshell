import { beforeEach as beforeLanguageTest } from "vitest";
import { initializeI18n as setTestLanguage } from "../i18n";
beforeLanguageTest(() => setTestLanguage("zh-CN"));
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import QuickCommandManager from "./QuickCommandManager";
import { DialogProvider } from "./DialogProvider";
import type { QuickCommand } from "../types";

afterEach(cleanup);

const commands: QuickCommand[] = [
  {
    id: "1",
    name: "磁盘",
    command: "df -h",
    category: "系统",
    scope: "global",
    scopeId: "",
    mode: "run",
    confirm: false,
  },
  {
    id: "2",
    name: "内存",
    command: "free -h",
    category: "系统",
    scope: "global",
    scopeId: "",
    mode: "run",
    confirm: false,
  },
];

test("manager edits and saves existing commands", async () => {
  const save = vi.fn(async (_commands: QuickCommand[]) => {});
  render(
    <DialogProvider>
      <QuickCommandManager
        commands={commands}
        groups={[]}
        sessions={[]}
        onSave={save}
        onClose={vi.fn()}
      />
    </DialogProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /磁盘/ }));
  fireEvent.change(screen.getByLabelText("命令内容"), {
    target: { value: "df -Th" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存命令" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0][0].command).toBe("df -Th");
});

test("manager accepts multiline commands, preserves trailing Enter and removes action selector", async () => {
  const save = vi.fn(async (_commands: QuickCommand[]) => {});
  render(
    <DialogProvider>
      <QuickCommandManager
        commands={commands}
        groups={[]}
        sessions={[]}
        onSave={save}
        onClose={vi.fn()}
      />
    </DialogProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /磁盘/ }));
  expect(screen.queryByLabelText("点击后的操作")).toBeNull();
  expect(screen.getByText(/换行表示按下 Enter/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("命令内容"), {
    target: { value: "ls\npwd\n" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存命令" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0][0].command).toBe("ls\npwd\n");
  expect(save.mock.calls[0][0][0].mode).toBeUndefined();
});

test("manager rejects control characters in command content", async () => {
  const save = vi.fn(async (_commands: QuickCommand[]) => {});
  render(
    <DialogProvider>
      <QuickCommandManager
        commands={commands}
        groups={[]}
        sessions={[]}
        onSave={save}
        onClose={vi.fn()}
      />
    </DialogProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /磁盘/ }));
  fireEvent.change(screen.getByLabelText("命令内容"), {
    target: { value: "ls\u0000" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存命令" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
});

test("removing a quick command requires a custom confirmation", async () => {
  const save = vi.fn(async (_commands: QuickCommand[]) => {});
  render(
    <DialogProvider>
      <QuickCommandManager
        commands={commands}
        groups={[]}
        sessions={[]}
        onSave={save}
        onClose={vi.fn()}
      />
    </DialogProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /磁盘/ }));
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  expect(
    await screen.findByRole("alertdialog", { name: "删除快速命令" }),
  ).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "删除命令" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith([commands[1]]));
});
