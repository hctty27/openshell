import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
import AIModelPicker from "./AIModelPicker";
import type { AIProvider } from "../types";

const providers: AIProvider[] = [
  {
    id: "p1", name: "cpa", baseUrl: "https://example.test/v1", hasKey: true,
    models: [{ id: "grok-4.7", name: "grok-4.7" }, { id: "gpt-6", name: "gpt-6" }],
  },
  {
    id: "p2", name: "Custom API", baseUrl: "https://other.test/v1", hasKey: true,
    models: [{ id: "grok-4.7", name: "grok-4.7" }, { id: "model-high", name: "model-high" }],
  },
];

beforeEach(async () => { await initializeI18n("zh-CN"); });
afterEach(cleanup);

test("combines provider and model in a single searchable picker", () => {
  const onChange = vi.fn();
  render(<AIModelPicker providers={providers} providerID="p1" modelID="grok-4.7"
    onChange={onChange} />);
  const picker = screen.getByRole("combobox", { name: "选择 AI 模型" });
  expect(picker.textContent).toContain("cpa · grok-4.7");
  fireEvent.click(picker);
  expect(screen.getByRole("group", { name: "cpa" })).toBeTruthy();
  expect(screen.getByRole("group", { name: "Custom API" })).toBeTruthy();
  const search = screen.getByRole("searchbox", { name: "搜索 API 或模型" });
  fireEvent.change(search, { target: { value: "high" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(search, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("p2", "model-high");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("same model ID in different providers remains unambiguous", () => {
  const onChange = vi.fn();
  render(<AIModelPicker providers={providers} providerID="p1" modelID="grok-4.7"
    onChange={onChange} />);
  fireEvent.click(screen.getByRole("combobox", { name: "选择 AI 模型" }));
  const secondGroup = screen.getByRole("group", { name: "Custom API" });
  fireEvent.click(secondGroup.querySelector<HTMLButtonElement>('[role="option"]')!);
  expect(onChange).toHaveBeenCalledWith("p2", "grok-4.7");
});

test("deleted historical model is not silently replaced", () => {
  render(<AIModelPicker providers={providers} providerID="p1" modelID="removed-model"
    onChange={vi.fn()} />);
  expect(screen.getByRole("combobox", { name: "选择 AI 模型" }).getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByText("模型不可用，请重新选择")).toBeTruthy();
});

test("picker is disabled while AI is executing", () => {
  render(<AIModelPicker providers={providers} providerID="p1" modelID="gpt-6"
    disabled onChange={vi.fn()} />);
  expect((screen.getByRole("combobox", { name: "选择 AI 模型" }) as HTMLButtonElement).disabled).toBe(true);
});
