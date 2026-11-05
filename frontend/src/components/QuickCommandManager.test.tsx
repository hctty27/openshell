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
  fireEvent.click(screen.getByText("磁盘").closest("button")!);
  fireEvent.change(screen.getByLabelText("命令内容"), {
    target: { value: "df -Th" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存命令" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0][0].command).toBe("df -Th");
  expect(save.mock.calls[0][0][0].category).toBe("系统");
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
  fireEvent.click(screen.getByText("磁盘").closest("button")!);
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
  fireEvent.click(screen.getByText("磁盘").closest("button")!);
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
  fireEvent.click(screen.getByText("磁盘").closest("button")!);
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  expect(
    await screen.findByRole("alertdialog", { name: "删除快速命令" }),
  ).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "删除命令" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith([commands[1]]));
});

test("manager removes category controls and searches command name and content", () => {
  const { container } = render(
    <DialogProvider>
      <QuickCommandManager
        commands={commands}
        groups={[]}
        sessions={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    </DialogProvider>,
  );
  expect(screen.queryByLabelText("命令分类")).toBeNull();
  expect(screen.queryByLabelText("筛选命令分类")).toBeNull();
  const search = screen.getByRole("searchbox", { name: "搜索命令..." });
  fireEvent.change(search, { target: { value: "free" } });
  expect(container.querySelectorAll(".quick-manager-item")).toHaveLength(1);
  expect(screen.getByText("内存").closest("button")!).toBeTruthy();
  fireEvent.change(search, { target: { value: "not-found" } });
  expect(screen.getByText("没有匹配的命令")).toBeTruthy();
});

test("manager supports keyboard ordering without visible arrow buttons", async () => {
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
  expect(screen.queryByTitle("上移")).toBeNull();
  expect(screen.queryByTitle("下移")).toBeNull();
  fireEvent.keyDown(screen.getByRole("button", { name: "调整「磁盘」顺序" }), {
    key: "ArrowDown",
    altKey: true,
  });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0].map((command) => command.id)).toEqual(["2", "1"]);
});

test("manager supports drag-to-reorder", async () => {
  const save = vi.fn(async (_commands: QuickCommand[]) => {});
  const { container } = render(
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
  const transfer = {
    effectAllowed: "none",
    dropEffect: "none",
    setData: vi.fn(),
    getData: vi.fn(),
    types: [],
  };
  fireEvent.dragStart(screen.getByRole("button", { name: "调整「磁盘」顺序" }), {
    dataTransfer: transfer,
  });
  const target = container.querySelectorAll(".quick-manager-item")[1];
  fireEvent.dragOver(target, { dataTransfer: transfer });
  fireEvent.drop(target, { dataTransfer: transfer });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0].map((command) => command.id)).toEqual(["2", "1"]);
});

test("manager saves with Ctrl+S", async () => {
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
  fireEvent.click(screen.getByText("磁盘").closest("button")!);
  fireEvent.keyDown(screen.getByLabelText("命令内容"), { key: "s", ctrlKey: true });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
});
