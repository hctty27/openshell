import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SFTPView from "./SFTPView";
import { DialogProvider } from "./DialogProvider";
import { initializeI18n } from "../i18n";
import { Clipboard } from "@wailsio/runtime";
import { BASH_CWD_REPORT_COMMAND } from "../terminalCwd";
import { api } from "../bridge";
import type { Ref } from "../types";

vi.mock("../bridge", () => ({
  api: {
    SFTPHome: vi.fn(async () => ({ local: "C:/temp", remote: "/root" })),
    SFTPTransfers: vi.fn(async () => []),
    SFTPList: vi.fn(async () => []),
  },
  listen: () => () => {},
  errorText: (value: unknown) => String(value),
}));
vi.mock("@wailsio/runtime", () => ({
  Clipboard: { SetText: vi.fn(async () => {}) },
}));

const ref: Ref = { tabId: "tab-1", sessionId: "server-1", generation: 1 };
beforeEach(async () => {
  await initializeI18n("zh-CN");
  vi.clearAllMocks();
});
afterEach(cleanup);

test("Bash cwd helper reports rejected clipboard writes", async () => {
  vi.mocked(Clipboard.SetText).mockRejectedValueOnce(new Error("clipboard unavailable"));
  const onNotice = vi.fn();
  render(<DialogProvider><SFTPView refID={ref} onNotice={onNotice} cwdReported={false}/></DialogProvider>);
  fireEvent.click(screen.getByRole("button", { name: "复制 Bash 目录同步命令" }));
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.any(Error)));
  expect((onNotice.mock.calls[0][0] as Error).message).toBe("clipboard unavailable");
});

test("Bash cwd helper reports success when Wails v3 clipboard resolves", async () => {
  const onNotice = vi.fn();
  render(<DialogProvider><SFTPView refID={ref} onNotice={onNotice} cwdReported={false}/></DialogProvider>);
  fireEvent.click(screen.getByRole("button", { name: "复制 Bash 目录同步命令" }));
  await waitFor(() => expect(Clipboard.SetText).toHaveBeenCalledWith(BASH_CWD_REPORT_COMMAND));
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("已复制 Bash")));
});

test("SFTP context menu copies a file path with Wails v3 clipboard", async () => {
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) => side === "remote"
    ? [{ name: "test.txt", path: "/root/test.txt", isDir: false, isSymlink: false,
      size: 1, modified: 0, mode: "-rw-r--r--" }]
    : []);
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}/></DialogProvider>);

  const row = (await screen.findByText("test.txt")).closest('[role="listitem"]')!;
  fireEvent.contextMenu(row);
  fireEvent.click(await screen.findByRole("menuitem", { name: "复制路径" }));
  await waitFor(() => expect(Clipboard.SetText).toHaveBeenCalledWith("/root/test.txt"));
});
