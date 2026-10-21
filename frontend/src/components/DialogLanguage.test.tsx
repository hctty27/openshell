import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
import { message } from "../i18n/message";
import { DialogProvider, useDialogs } from "./DialogProvider";
afterEach(cleanup);
test("active and queued dialogs change language without losing input", async () => {
  await initializeI18n("en");
  const done = vi.fn();
  function Buttons() {
    const dialogs = useDialogs();
    return (
      <button
        onClick={() => {
          void dialogs
            .input({
              title: message("common:close"),
              label: message("common:settings"),
              defaultValue: "my-server",
            })
            .then(done);
          void dialogs
            .confirm({
              title: message("common:settings"),
              description: message("common:close"),
            })
            .then(done);
        }}
      >
        Open
      </button>
    );
  }
  render(
    <DialogProvider>
      <Buttons />
    </DialogProvider>,
  );
  fireEvent.click(screen.getByText("Open"));
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "new-server" } });
  await act(() => initializeI18n("zh-CN"));
  expect(screen.getByRole("dialog", { name: "关闭" })).toBeTruthy();
  expect((input as HTMLInputElement).value).toBe("new-server");
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(done).toHaveBeenCalledWith("new-server"));
  expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(done).toHaveBeenLastCalledWith(false));
  expect(done).toHaveBeenCalledTimes(2);
});
