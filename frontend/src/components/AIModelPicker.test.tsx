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

test("shows flat provider-model labels without search or group headers", () => {
  const onChange = vi.fn();
  render(<AIModelPicker providers={providers} providerID="p1" modelID="grok-4.7"
    onChange={onChange} />);
  const picker = screen.getByRole("combobox", { name: "选择 AI 模型" });
  expect(picker.textContent).toContain("cpa · grok-4.7");
  fireEvent.click(picker);

  expect(screen.queryByRole("searchbox")).toBeNull();
  expect(screen.queryByRole("group")).toBeNull();
  expect(screen.getAllByRole("option").map(option => option.textContent?.trim())).toEqual([
    "cpa · grok-4.7", "cpa · gpt-6",
    "Custom API · grok-4.7", "Custom API · model-high",
  ]);
  fireEvent.keyDown(picker, { key: "ArrowDown" });
  fireEvent.keyDown(picker, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("p1", "gpt-6");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("same model ID in different providers remains unambiguous", () => {
  const onChange = vi.fn();
  render(<AIModelPicker providers={providers} providerID="p1" modelID="grok-4.7"
    onChange={onChange} />);
  fireEvent.click(screen.getByRole("combobox", { name: "选择 AI 模型" }));
  const duplicate = screen.getByRole("option", { name: "Custom API · grok-4.7" });
  fireEvent.click(duplicate);
  expect(onChange).toHaveBeenCalledWith("p2", "grok-4.7");
});

test("picker supports Home, End and Escape with trigger focus", () => {
  const onChange = vi.fn();
  render(<AIModelPicker providers={providers} providerID="p1" modelID="grok-4.7"
    onChange={onChange} />);
  const picker = screen.getByRole("combobox", { name: "选择 AI 模型" });
  fireEvent.click(picker);
  fireEvent.keyDown(picker, { key: "End" });
  expect(picker.getAttribute("aria-activedescendant")).toBe(
    screen.getByRole("option", { name: "Custom API · model-high" }).id,
  );
  fireEvent.keyDown(picker, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();

  fireEvent.click(picker);
  fireEvent.keyDown(picker, { key: "End" });
  fireEvent.keyDown(picker, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("p2", "model-high");
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


test("model picker labels follow the current language", async () => {
  await initializeI18n("en");
  render(<AIModelPicker providers={providers} providerID="p1" modelID="missing"
    onChange={vi.fn()} />);
  expect(screen.getByRole("combobox", { name: "Choose AI model" })).toBeTruthy();
  expect(screen.getByText("Model unavailable. Select another model.")).toBeTruthy();
});
