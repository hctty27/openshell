import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
import { api } from "../bridge";
import { AI_PROVIDERS_CHANGED } from "../features/ai/providerEvents";
import type { AIProvider } from "../types";
import AIProviderSettings from "./AIProviderSettings";

const confirm = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../bridge", () => ({
  api: {
    AIProviders: vi.fn(async () => []),
    AISaveProvider: vi.fn(async (request: { provider: AIProvider }) => ({
      ...request.provider, id: "new-provider", hasKey: true,
    })),
    AIDeleteProvider: vi.fn(async () => {}),
    AIRuntimeSettings: vi.fn(async () => ({
      autoCompact: true, compactThreshold: 90, maxSteps: 12,
      taskTimeoutMinutes: 10, keepRecentTurns: 6,
    })),
    AISaveRuntimeSettings: vi.fn(async () => {}),
  },
  errorText: (value: unknown) => String(value),
}));
vi.mock("./DialogProvider", () => ({ useDialogs: () => ({ confirm }) }));

beforeEach(async () => {
  await initializeI18n("zh-CN");
  vi.mocked(api.AIProviders).mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test("adds multiple models for one provider and notifies the open sidebar", async () => {
  const notify = vi.fn();
  window.addEventListener(AI_PROVIDERS_CHANGED, notify);
  render(<AIProviderSettings />);
  await screen.findByRole("button", { name: "添加 API" });
  fireEvent.change(screen.getByPlaceholderText("请输入配置名称"), { target: { value: "cpa" } });
  fireEvent.change(screen.getByPlaceholderText("https://api.example.com/v1"), {
    target: { value: "https://example.test/v1" },
  });
  fireEvent.change(screen.getByPlaceholderText("sk-..."), { target: { value: "sk-sample" } });
  fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
  fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
  const modelIDs = screen.getAllByLabelText("模型 ID");
  fireEvent.change(modelIDs[0], { target: { value: "grok-4.7" } });
  fireEvent.change(modelIDs[1], { target: { value: "gpt-6" } });
  fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
  await waitFor(() => expect(api.AISaveProvider).toHaveBeenCalledWith(expect.objectContaining({
    provider: expect.objectContaining({
      name: "cpa",
      models: [expect.objectContaining({ id: "grok-4.7", name: "grok-4.7" }), expect.objectContaining({ id: "gpt-6", name: "gpt-6" })],
    }),
    apiKey: "sk-sample",
  })));
  expect(notify).toHaveBeenCalledTimes(1);
  window.removeEventListener(AI_PROVIDERS_CHANGED, notify);
});

test("editing an existing provider leaves saved key untouched when blank", async () => {
  const saved: AIProvider = {
    id: "p1", name: "cpa", baseUrl: "https://example.test/v1",
    hasKey: true, models: [{ id: "grok-4.7", name: "grok-4.7" }],
  };
  vi.mocked(api.AIProviders).mockResolvedValueOnce([saved]);
  render(<AIProviderSettings />);
  const providerButton = await screen.findByRole("button", { name: /cpa/ });
  fireEvent.click(providerButton);
  expect(screen.getByPlaceholderText("已保存密钥，留空保持不变")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
  await waitFor(() => expect(api.AISaveProvider).toHaveBeenCalledWith(expect.objectContaining({
    provider: expect.objectContaining({ id: "p1" }), apiKey: "",
  })));
});

test("validates duplicate model IDs before saving a provider", async () => {
  render(<AIProviderSettings />);
  await screen.findByRole("button", { name: "添加 API" });
  fireEvent.change(screen.getByPlaceholderText("请输入配置名称"), { target: { value: "sample" } });
  fireEvent.change(screen.getByPlaceholderText("https://api.example.com/v1"), {
    target: { value: "https://example.test/v1" },
  });
  fireEvent.change(screen.getByPlaceholderText("sk-..."), { target: { value: "sk-sample" } });
  fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
  fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
  const ids = screen.getAllByLabelText("模型 ID");
  fireEvent.change(ids[0], { target: { value: "same-model" } });
  fireEvent.change(ids[1], { target: { value: "same-model" } });
  fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
  expect(screen.getByRole("alert").textContent).toContain("模型 ID 不能重复");
  expect(api.AISaveProvider).not.toHaveBeenCalled();
});

test("discarding context edits on tab switch resets the runtime form", async () => {
  render(<AIProviderSettings />);
  fireEvent.click(screen.getByRole("tab", { name: "上下文" }));
  const compact = await screen.findByLabelText("自动压缩上下文") as HTMLInputElement;
  await waitFor(() => expect(compact.checked).toBe(true));
  fireEvent.click(compact);
  fireEvent.click(screen.getByRole("tab", { name: "执行行为" }));
  await screen.findByLabelText("单次最大循环次数");
  expect(confirm).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("tab", { name: "上下文" }));
  await waitFor(() => expect((screen.getByLabelText("自动压缩上下文") as HTMLInputElement).checked).toBe(true));
});
