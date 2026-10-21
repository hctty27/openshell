import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import { expect, test, vi, afterEach } from "vitest";
import App from "./App";
import { api } from "./bridge";
vi.mock("./components/TerminalPane", () => ({ default: () => null }));
vi.mock("./bridge", () => ({
  desktop: false,
  api: {
    SavePreference: vi.fn(async () => {}),
    State: vi.fn(async () => ({
      sessions: [],
      groups: [],
      profiles: [],
      fontSize: "14",
      activeProfile: "",
      version: "0.1.11",
    })),
  },
  listen: () => () => {},
}));
afterEach(cleanup);
test("shows workspace and collapsible AI sidebar", async () => {
  await act(async () => {
    render(<App />);
  });
  expect(screen.getAllByText("会话管理")[0]).toBeTruthy();
  expect(screen.getAllByText("SSH 终端")[0]).toBeTruthy();
  expect(screen.getByText("AI 助手")).toBeTruthy();
  fireEvent.click(screen.getByTitle("收起 AI"));
  expect(screen.queryByText("AI 助手")).toBeNull();
});
test("theme previews immediately and is saved in appearance settings", async () => {
  await act(async () => {
    render(<App />);
  });
  fireEvent.click(screen.getByTitle("设置"));
  fireEvent.change(screen.getByLabelText("主题"), {
    target: { value: "light" },
  });
  expect(document.documentElement.dataset.theme).toBe("light");
  fireEvent.click(screen.getByRole("button", { name: "保存外观" }));
  await waitFor(() =>
    expect(api.SavePreference).toHaveBeenCalledWith("theme", "light"),
  );
  fireEvent.change(screen.getByLabelText("主题"), {
    target: { value: "dark" },
  });
  expect(document.documentElement.dataset.theme).toBe("dark");
});
test("opens session editor without connecting and rejects missing host", async () => {
  await act(async () => {
    render(<App />);
  });
  fireEvent.click(screen.getAllByTitle("新建会话")[0]);
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(screen.getByLabelText("主机地址")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存会话" }));
  expect(screen.getByText("请填写主机地址和用户名")).toBeTruthy();
});
test("API settings expose custom endpoint key and model fields", async () => {
  await act(async () => {
    render(<App />);
  });
  fireEvent.click(screen.getByTitle("设置"));
  fireEvent.click(screen.getByRole("button", { name: "AI API" }));
  expect(screen.getByLabelText("Base URL")).toBeTruthy();
  expect(screen.getByLabelText("API Key")).toBeTruthy();
  expect(screen.getByLabelText("模型名称")).toBeTruthy();
  await waitFor(() => expect(screen.getByText("OpenAI 兼容接口")).toBeTruthy());
});

test("shows the OpenShell product name", async () => {
  await act(async () => {
    render(<App />);
  });
  expect(screen.getAllByText("OpenShell").length).toBeGreaterThan(0);
  expect(screen.queryByText("轻量 SSH")).toBeNull();
});

test("renders application version on the left and SSH connection status on the right", async () => {
  await act(async () => {
    render(<App />);
  });
  const footer = document.querySelector(".workspace-status");
  expect(footer?.firstElementChild?.classList.contains("workspace-version")).toBe(true);
  expect(footer?.lastElementChild?.classList.contains("workspace-connection")).toBe(true);
  expect(footer?.textContent).toContain("v0.1.11");
  expect(footer?.textContent).toContain("未连接");
});

test("terminal mouse settings are opt-in and saved independently", async () => {
  await act(async () => {
    render(<App />);
  });
  fireEvent.click(screen.getByTitle("设置"));
  const copy = screen.getByLabelText("选中自动复制") as HTMLInputElement;
  const paste = screen.getByLabelText("鼠标右键粘贴") as HTMLInputElement;
  expect(copy.checked).toBe(false);
  expect(paste.checked).toBe(false);
  fireEvent.click(copy);
  fireEvent.click(paste);
  const confirm = screen.getByLabelText("多行粘贴前确认") as HTMLInputElement;
  expect(confirm.checked).toBe(true);
  fireEvent.click(confirm);
  fireEvent.click(screen.getByRole("button", { name: "保存外观" }));
  await waitFor(() => {
    expect(api.SavePreference).toHaveBeenCalledWith("autoCopySelection", "true");
    expect(api.SavePreference).toHaveBeenCalledWith("rightClickPaste", "true");
    expect(api.SavePreference).toHaveBeenCalledWith("confirmMultilinePaste", "false");
  });
});
