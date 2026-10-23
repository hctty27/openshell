import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
import { api } from "../bridge";
import type { Ref } from "../types";
import ZmodemFilePicker from "./ZmodemFilePicker";

const events = vi.hoisted(() => ({ callbacks: new Map<string, (payload: any) => void>() }));
vi.mock("../bridge", () => ({
  api: {
    ZmodemLocalPlaces: vi.fn(async () => ({ home: "/home/user", roots: ["/"] })),
    SFTPList: vi.fn(async () => [
      { name: "folder", path: "/home/user/folder", isDir: true, isSymlink: false, size: 0, modified: 0, mode: "0755" },
      { name: "hello.txt", path: "/home/user/hello.txt", isDir: false, isSymlink: false, size: 512, modified: 0, mode: "0644" },
    ]),
    SubmitZmodemSelection: vi.fn(async () => {}),
  },
  listen: (name: string, callback: (payload: any) => void) => {
    events.callbacks.set(name, callback);
    return () => events.callbacks.delete(name);
  },
  errorText: (error: unknown) => String(error),
}));

const ref: Ref = { tabId: "tab-1", sessionId: "session-1", generation: 1 };
const emit = (name: string, payload: unknown) =>
  act(() => { events.callbacks.get(name)?.(payload); });

beforeEach(async () => {
  events.callbacks.clear();
  vi.clearAllMocks();
  await initializeI18n("zh-CN");
});
afterEach(cleanup);

test("rz uses the embedded picker and sends selected paths without a native dialog", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:zmodem-pick", { ref, id: 1, direction: "upload" });
  expect(await screen.findByText("hello.txt")).toBeTruthy();
  fireEvent.click(screen.getByText("hello.txt"));
  fireEvent.click(screen.getByRole("button", { name: "上传选中文件" }));
  await waitFor(() => expect(api.SubmitZmodemSelection).toHaveBeenCalledWith(ref, 1, ["/home/user/hello.txt"]));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("sz chooses the current local destination directory", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:zmodem-pick", { ref, id: 2, direction: "download" });
  expect(await screen.findByText("hello.txt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存到此处" }));
  await waitFor(() => expect(api.SubmitZmodemSelection).toHaveBeenCalledWith(ref, 2, ["/home/user"]));
});

test("cancel does not start an upload", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:zmodem-pick", { ref, id: 3, direction: "upload" });
  expect(await screen.findByText("hello.txt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(api.SubmitZmodemSelection).toHaveBeenCalledWith(ref, 3, []));
});

test("a picker for another SSH tab does not cover the active tab", () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:zmodem-pick", {
    ref: { tabId: "tab-2", sessionId: "session-2", generation: 1 },
    id: 4, direction: "upload",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});
