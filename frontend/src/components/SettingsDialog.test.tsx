import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { initializeI18n } from "../i18n";
import { DialogProvider } from "./DialogProvider";
import SettingsDialog from "./SettingsDialog";

const savePreference = vi.hoisted(() => vi.fn(async (_key: string, _value: string) => {}));
vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return {
    ...actual,
    api: {
      ...actual.api,
      SavePreference: savePreference,
      GetTransferDefaultLocalDir: vi.fn(async () => ""),
    },
  };
});

beforeEach(() => {
  initializeI18n("zh-CN");
  savePreference.mockReset();
  savePreference.mockResolvedValue(undefined);
});
afterEach(cleanup);

function renderSessionEditor() {
  const onClose = vi.fn();
  const onSession = vi.fn(async () => {});
  render(
    <DialogProvider>
      <SettingsDialog
        kind="session"
        session={{
          id: "session-1",
          groupId: "",
          name: "Example",
          host: "192.168.1.10",
          port: 22,
          username: "root",
          authType: "password",
          privateKeyPath: "",
          credentialRef: "",
        }}
        groups={[]}
        fontSize={14}
        theme="dark"
        onTheme={vi.fn()}
        terminalTheme="follow"
        onTerminalTheme={vi.fn()}
        autoCopySelection={false}
        onAutoCopySelection={vi.fn()}
        rightClickPaste={false}
        onRightClickPaste={vi.fn()}
        confirmMultilinePaste={true}
        logHighlights={false}
        onLogHighlights={vi.fn()}
        onConfirmMultilinePaste={vi.fn()}
        onClose={onClose}
        onSession={onSession}
        onRefresh={vi.fn(async () => {})}
        onFont={vi.fn()}
      />
    </DialogProvider>,
  );
  return { onClose, onSession };
}

test("session editor stays open when selecting a host outside the dialog", () => {
  const { onClose } = renderSessionEditor();
  const dialog = screen.getByRole("dialog", { name: "编辑会话" });
  const host = screen.getByPlaceholderText("IP 地址或域名");
  fireEvent.pointerDown(host, { button: 0 });
  fireEvent.pointerUp(dialog, { clientX: -10, clientY: -10 });
  fireEvent.click(dialog, { clientX: -10, clientY: -10 });
  fireEvent.pointerDown(dialog, { button: 0, clientX: -10, clientY: -10 });
  fireEvent.click(dialog, { clientX: -10, clientY: -10 });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "编辑会话" })).toBeTruthy();
});

test("closing an unchanged session editor requires no confirmation", () => {
  const { onClose } = renderSessionEditor();
  fireEvent.click(screen.getByTitle("关闭"));
  expect(onClose).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog", { name: "放弃未保存的修改？" })).toBeNull();
});

test("unsaved session changes require confirmation and can be retained", () => {
  const { onClose } = renderSessionEditor();
  const host = screen.getByPlaceholderText("IP 地址或域名") as HTMLInputElement;
  fireEvent.change(host, { target: { value: "10.0.0.2" } });
  fireEvent.click(screen.getByTitle("关闭"));
  expect(screen.getByRole("dialog", { name: "放弃未保存的修改？" })).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  expect(host.value).toBe("10.0.0.2");
  expect(onClose).not.toHaveBeenCalled();

  fireEvent(screen.getByRole("dialog", { name: "编辑会话" }), new Event("cancel", { cancelable: true }));
  expect(screen.getByRole("dialog", { name: "放弃未保存的修改？" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
  return waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

test("saving a modified session closes without a discard confirmation", async () => {
  const { onClose, onSession } = renderSessionEditor();
  fireEvent.change(screen.getByPlaceholderText("IP 地址或域名"), {
    target: { value: "10.0.0.2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存会话" }));
  await waitFor(() => expect(onSession).toHaveBeenCalledOnce());
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog", { name: "放弃未保存的修改？" })).toBeNull();
});

function renderPreferences() {
  const onClose = vi.fn();
  const onRefresh = vi.fn(async () => {});
  const onFont = vi.fn();
  const onPreferenceError = vi.fn();
  render(
    <DialogProvider>
      <SettingsDialog
        kind="settings"
        groups={[]}
        fontSize={14}
        theme="dark"
        onTheme={vi.fn()}
        terminalTheme="follow"
        onTerminalTheme={vi.fn()}
        autoCopySelection={false}
        onAutoCopySelection={vi.fn()}
        rightClickPaste={false}
        onRightClickPaste={vi.fn()}
        confirmMultilinePaste={true}
        logHighlights={false}
        onLogHighlights={vi.fn()}
        onConfirmMultilinePaste={vi.fn()}
        onClose={onClose}
        onSession={vi.fn(async () => {})}
        onRefresh={onRefresh}
        onFont={onFont}
        onPreferenceError={onPreferenceError}
      />
    </DialogProvider>,
  );
  return { onClose, onRefresh, onFont, onPreferenceError };
}

test("preferences dialog has no footer and saves appearance and terminal controls automatically", async () => {
  const { onFont } = renderPreferences();
  expect(document.querySelector(".settings-dialog--settings > footer")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "外观" }));
  fireEvent.click(screen.getByRole("button", { name: "浅色" }));
  fireEvent.change(screen.getByLabelText("终端配色方案"), { target: { value: "classic" } });
  fireEvent.change(screen.getByLabelText("字体大小"), { target: { value: "18" } });

  fireEvent.click(screen.getByRole("button", { name: "终端" }));
  fireEvent.click(screen.getByLabelText("鼠标右键粘贴"));

  await waitFor(() => expect(savePreference).toHaveBeenCalledWith("theme", "light"));
  await waitFor(() => expect(savePreference).toHaveBeenCalledWith("terminalTheme", "classic"));
  await waitFor(() => expect(savePreference).toHaveBeenCalledWith("fontSize", "18"));
  await waitFor(() => expect(savePreference).toHaveBeenCalledWith("rightClickPaste", "true"));
  expect(onFont).toHaveBeenCalledWith(18);
  expect(screen.queryByRole("button", { name: "保存设置" })).toBeNull();
});

test("connection changes persist immediately and refresh the app state", async () => {
  const { onRefresh, onClose } = renderPreferences();
  fireEvent.click(screen.getByRole("button", { name: "连接" }));
  fireEvent.change(screen.getByLabelText("SSH 断开后的操作"), {
    target: { value: "retain" },
  });
  await waitFor(() => expect(savePreference).toHaveBeenCalledWith("disconnectBehavior", "retain"));
  await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());

  fireEvent.click(screen.getByTitle("关闭"));
  expect(onClose).toHaveBeenCalledOnce();
  expect(document.querySelector(".settings-dialog--settings > footer")).toBeNull();
});

test("preference write failures remain visible and notify the app", async () => {
  savePreference.mockRejectedValueOnce(new Error("写入失败"));
  const { onPreferenceError } = renderPreferences();
  fireEvent.click(screen.getByRole("button", { name: "外观" }));
  fireEvent.click(screen.getByRole("button", { name: "浅色" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("写入失败"));
  expect(onPreferenceError).toHaveBeenCalledOnce();
});

test("terminal settings no longer expose a ZMODEM engine selector", () => {
  renderPreferences();
  fireEvent.click(screen.getByRole("button", { name: "终端" }));
  expect(screen.queryByLabelText("ZMODEM 传输引擎")).toBeNull();
  expect(savePreference).not.toHaveBeenCalledWith("zmodemTransferMode", expect.anything());
});
