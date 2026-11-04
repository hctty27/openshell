import { Browser, Clipboard } from "@wailsio/runtime";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import packageManifest from "../../package.json";
import { initializeI18n } from "../i18n";
import AboutSettingsPanel from "./AboutSettingsPanel";

vi.mock("@wailsio/runtime", () => ({
  Browser: { OpenURL: vi.fn().mockResolvedValue(undefined) },
  Clipboard: { SetText: vi.fn().mockResolvedValue(undefined) },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  await initializeI18n("zh-CN");
});
afterEach(cleanup);

test("About panel shows developer, contact, version and project links", () => {
  render(<AboutSettingsPanel />);

  expect(screen.getByText("hctty27")).toBeTruthy();
  expect(screen.getByText("ynk27.nb@gmail.com")).toBeTruthy();
  expect(screen.getByText(`版本 v${packageManifest.version}`)).toBeTruthy();
  expect(screen.getByRole("button", { name: "官方网站" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "GitHub 开源仓库" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "问题反馈" })).toBeTruthy();
});

test("About panel copies the public contact email", async () => {
  render(<AboutSettingsPanel />);
  fireEvent.click(screen.getByRole("button", { name: "复制邮箱" }));

  await waitFor(() => {
    expect(Clipboard.SetText).toHaveBeenCalledWith("ynk27.nb@gmail.com");
    expect(screen.getByRole("status").textContent).toBe("邮箱已复制");
  });
});

test("About panel opens email and project links using the system browser", async () => {
  render(<AboutSettingsPanel />);
  fireEvent.click(screen.getByTitle("发送邮件"));
  fireEvent.click(screen.getByRole("button", { name: "官方网站" }));
  fireEvent.click(screen.getByRole("button", { name: "GitHub 开源仓库" }));
  fireEvent.click(screen.getByRole("button", { name: "问题反馈" }));
  fireEvent.click(screen.getByRole("button", { name: /MIT License/ }));

  await waitFor(() => {
    expect(Browser.OpenURL).toHaveBeenCalledWith("mailto:ynk27.nb@gmail.com");
    expect(Browser.OpenURL).toHaveBeenCalledWith("https://openshell.testnb.me");
    expect(Browser.OpenURL).toHaveBeenCalledWith("https://github.com/hctty27/openshell");
    expect(Browser.OpenURL).toHaveBeenCalledWith("https://github.com/hctty27/openshell/issues");
    expect(Browser.OpenURL).toHaveBeenCalledWith("https://github.com/hctty27/openshell/blob/main/LICENSE");
  });
});

test("About panel reports clipboard errors without claiming success", async () => {
  vi.mocked(Clipboard.SetText).mockRejectedValueOnce(new Error("permission denied"));
  render(<AboutSettingsPanel />);

  fireEvent.click(screen.getByRole("button", { name: "复制邮箱" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("复制邮箱失败"));
});

test("About panel has English translations", async () => {
  await initializeI18n("en");
  render(<AboutSettingsPanel />);
  expect(screen.getByText("Developer")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Official website" })).toBeTruthy();
});
