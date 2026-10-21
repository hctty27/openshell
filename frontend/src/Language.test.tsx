import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import { api } from "./bridge";
import { initializeI18n, i18n } from "./i18n";
vi.mock("./components/TerminalPane", () => ({ default: () => null }));
vi.mock("./bridge", () => ({
  desktop: true,
  api: { State: vi.fn(), SavePreference: vi.fn() },
  listen: () => () => {},
  errorText: (e: unknown) =>
    typeof e === "object" && e && "key" in e
      ? i18n.t(e.key as never)
      : String(e),
}));
const state = {
  sessions: [],
  groups: [],
  profiles: [],
  fontSize: "14",
  activeProfile: "",
  version: "test",
  language: "en",
};
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(api.State).mockResolvedValue(state as never);
  vi.mocked(api.SavePreference).mockResolvedValue();
  await initializeI18n("en");
});
afterEach(cleanup);
test("saved language is initialized before the workspace renders", async () => {
  let resolve!: (v: never) => void;
  vi.mocked(api.State).mockReturnValue(new Promise((r) => (resolve = r)));
  render(<App />);
  expect(document.querySelector(".workspace-status")).toBeNull();
  await act(async () => resolve({ ...state, language: "zh-CN" } as never));
  await screen.findByTitle("设置");
  expect(i18n.language).toBe("zh-CN");
});
test("startup failure is retryable", async () => {
  vi.mocked(api.State).mockRejectedValueOnce(new Error("offline"));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await screen.findByTitle("Settings");
  expect(api.State).toHaveBeenCalledTimes(2);
});
test("language changes save immediately and failed saves retain the previous language", async () => {
  render(<App />);
  fireEvent.click(await screen.findByTitle("Settings"));
  const select = screen.getByLabelText("Interface language");
  fireEvent.change(select, { target: { value: "zh-CN" } });
  await waitFor(() => expect(i18n.language).toBe("zh-CN"));
  expect(api.SavePreference).toHaveBeenCalledWith("language", "zh-CN");
  vi.mocked(api.SavePreference).mockRejectedValueOnce(new Error("save failed"));
  fireEvent.change(select, { target: { value: "en" } });
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("save failed"),
  );
  expect(i18n.language).toBe("zh-CN");
  expect((select as HTMLSelectElement).value).toBe("zh-CN");
});
test("language selection is locked while persistence is pending", async () => {
  render(<App />);
  fireEvent.click(await screen.findByTitle("Settings"));
  let resolve!: () => void;
  vi.mocked(api.SavePreference).mockReturnValueOnce(
    new Promise((r) => (resolve = r)),
  );
  const select = screen.getByLabelText("Interface language") as HTMLSelectElement;
  fireEvent.change(select, { target: { value: "zh-CN" } });
  expect(select.disabled).toBe(true);
  expect(i18n.language).toBe("en");
  await act(async () => resolve());
  await waitFor(() => expect(select.disabled).toBe(false));
  expect(i18n.language).toBe("zh-CN");
});
test("visible validation errors update when the language changes", async () => {
  render(<App />);
  fireEvent.click(await screen.findByTitle("New session"));
  fireEvent.click(screen.getByRole("button", { name: "Save session" }));
  expect(screen.getByRole("alert").textContent).toBe(
    "Enter a host and username",
  );
  await act(() => initializeI18n("zh-CN"));
  expect(screen.getByRole("alert").textContent).toBe("请填写主机地址和用户名");
});
