import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SFTPView from "./SFTPView";
import { DialogProvider } from "./DialogProvider";
import { initializeI18n } from "../i18n";
import { ClipboardSetText } from "../../wailsjs/runtime/runtime";
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
vi.mock("../../wailsjs/runtime/runtime", () => ({
  ClipboardSetText: vi.fn(async () => true),
}));
vi.mock("./SFTPAIAssistant", () => ({ default: () => null }));

const ref: Ref = { tabId: "tab-1", sessionId: "server-1", generation: 1 };
beforeEach(async () => {
  await initializeI18n("zh-CN");
  vi.clearAllMocks();
});
afterEach(cleanup);

test("Bash cwd helper reports clipboard failure rather than false success", async () => {
  vi.mocked(ClipboardSetText).mockResolvedValueOnce(false);
  const onNotice = vi.fn();
  render(<DialogProvider><SFTPView refID={ref} profileID="" onNotice={onNotice} cwdReported={false}/></DialogProvider>);
  fireEvent.click(screen.getByRole("button", { name: "复制 Bash 目录同步命令" }));
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.any(Error)));
  expect((onNotice.mock.calls[0][0] as Error).message).toBe("复制目录同步命令失败，请重试。");
});

test("Bash cwd helper reports success only when clipboard confirms", async () => {
  vi.mocked(ClipboardSetText).mockResolvedValueOnce(true);
  const onNotice = vi.fn();
  render(<DialogProvider><SFTPView refID={ref} profileID="" onNotice={onNotice} cwdReported={false}/></DialogProvider>);
  fireEvent.click(screen.getByRole("button", { name: "复制 Bash 目录同步命令" }));
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("已复制 Bash")));
});
