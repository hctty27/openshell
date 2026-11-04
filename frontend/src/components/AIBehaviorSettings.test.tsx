import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
import { api } from "../bridge";
import AIBehaviorSettings, { AI_RUNTIME_SETTINGS_CHANGED } from "./AIBehaviorSettings";

vi.mock("../bridge", () => ({
  api: {
    AIRuntimeSettings: vi.fn(async () => ({
      autoCompact: true, compactThreshold: 90, maxSteps: 12,
      taskTimeoutMinutes: 10, keepRecentTurns: 6,
    })),
    AISaveRuntimeSettings: vi.fn(async () => {}),
  },
  errorText: (error: unknown) => String(error),
}));

beforeEach(async () => { await initializeI18n("zh-CN"); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test("loads, saves and broadcasts runtime options without nesting in provider form", async () => {
  const changed = vi.fn();
  window.addEventListener(AI_RUNTIME_SETTINGS_CHANGED, changed);
  render(<AIBehaviorSettings />);
  const check = await screen.findByLabelText("自动压缩上下文") as HTMLInputElement;
  expect(check.checked).toBe(true);

  fireEvent.change(screen.getByLabelText("单次最大循环次数"), { target: { value: "30" } });
  fireEvent.change(screen.getByLabelText("单次任务超时"), { target: { value: "20" } });
  fireEvent.click(screen.getByText("高级设置"));
  fireEvent.change(screen.getByLabelText("保留最近完整对话"), { target: { value: "10" } });
  fireEvent.click(check);
  expect((screen.getByLabelText("自动压缩阈值") as HTMLSelectElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "保存 AI 设置" }));

  await waitFor(() => expect(api.AISaveRuntimeSettings).toHaveBeenCalledWith({
    autoCompact: false, compactThreshold: 90, maxSteps: 30,
    taskTimeoutMinutes: 20, keepRecentTurns: 10,
  }));
  expect(changed).toHaveBeenCalledTimes(1);
  window.removeEventListener(AI_RUNTIME_SETTINGS_CHANGED, changed);
});
