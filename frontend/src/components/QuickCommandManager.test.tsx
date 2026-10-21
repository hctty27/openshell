import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import QuickCommandManager from "./QuickCommandManager";
import type { QuickCommand } from "../types";

afterEach(cleanup);

const commands: QuickCommand[] = [
  { id: "1", name: "磁盘", command: "df -h", category: "系统", scope: "global", scopeId: "", mode: "run", confirm: false },
  { id: "2", name: "内存", command: "free -h", category: "系统", scope: "global", scopeId: "", mode: "run", confirm: false },
];

test("manager edits and saves existing commands", async () => {
  const save = vi.fn(async (_commands: QuickCommand[]) => {});
  render(<QuickCommandManager commands={commands} groups={[]} sessions={[]} onSave={save} onClose={vi.fn()}/>);
  fireEvent.click(screen.getByRole("button", { name: /磁盘/ }));
  fireEvent.change(screen.getByLabelText("命令内容"), { target: { value: "df -Th" } });
  fireEvent.click(screen.getByRole("button", { name: "保存命令" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0][0].command).toBe("df -Th");
});

test("manager prevents multiline command submission", async () => {
  const save = vi.fn(async (_commands: QuickCommand[]) => {});
  render(<QuickCommandManager commands={commands} groups={[]} sessions={[]} onSave={save} onClose={vi.fn()}/>);
  fireEvent.click(screen.getByRole("button", { name: /磁盘/ }));
  fireEvent.change(screen.getByLabelText("命令内容"), { target: { value: "ls\nrm -rf /" } });
  fireEvent.click(screen.getByRole("button", { name: "保存命令" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
});
