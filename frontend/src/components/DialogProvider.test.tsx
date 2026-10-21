import { beforeEach as beforeLanguageTest } from "vitest";
import { initializeI18n as setTestLanguage } from "../i18n";
beforeLanguageTest(() => setTestLanguage("zh-CN"));
import {
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DialogProvider, useDialogs } from "./DialogProvider";

function TestButtons({
  onConfirm,
  onInput,
}: {
  onConfirm: (accepted: boolean) => void;
  onInput: (value: string | null) => void;
}) {
  const dialogs = useDialogs();
  return (
    <>
      <button
        onClick={async () =>
          onConfirm(
            await dialogs.confirm({
              title: "删除会话",
              description: "该操作无法撤销",
              tone: "danger",
              confirmLabel: "删除",
            }),
          )
        }
      >
        打开确认
      </button>
      <button
        onClick={async () =>
          onInput(
            await dialogs.input({
              title: "新建分组",
              label: "分组名称",
              placeholder: "例如：生产服务器",
              confirmLabel: "创建分组",
            }),
          )
        }
      >
        打开输入
      </button>
    </>
  );
}
afterEach(cleanup);

test("themed input trims text and resolves without browser prompt", async () => {
  const onConfirm = vi.fn();
  const onInput = vi.fn();
  render(
    <DialogProvider>
      <TestButtons onConfirm={onConfirm} onInput={onInput} />
    </DialogProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "打开输入" }));
  expect(await screen.findByRole("dialog", { name: "新建分组" })).toBeTruthy();
  const input = screen.getByRole("textbox", { name: "分组名称" });
  fireEvent.change(input, { target: { value: "  生产服务器  " } });
  fireEvent.click(screen.getByRole("button", { name: "创建分组" }));
  await waitFor(() => expect(onInput).toHaveBeenCalledWith("生产服务器"));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("danger confirmation does not execute on cancel and resolves on accept", async () => {
  const onConfirm = vi.fn();
  const onInput = vi.fn();
  render(
    <DialogProvider>
      <TestButtons onConfirm={onConfirm} onInput={onInput} />
    </DialogProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "打开确认" }));
  expect(
    await screen.findByRole("alertdialog", { name: "删除会话" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(false));
  fireEvent.click(screen.getByRole("button", { name: "打开确认" }));
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(true));
});
