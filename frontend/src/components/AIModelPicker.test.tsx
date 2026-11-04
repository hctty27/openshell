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

test("model popup uses a body portal and dismisses on outside pointer down", () => {
  render(<div className="ai-compose">
    <AIModelPicker providers={providers} providerID="p1" modelID="gpt-6" onChange={vi.fn()} />
  </div>);
  fireEvent.click(screen.getByRole("combobox", { name: "选择 AI 模型" }));
  expect(screen.getByRole("listbox").closest(".ai-dropdown-popover")?.parentElement).toBe(document.body);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("Escape dismisses the model popup and restores trigger focus", () => {
  render(<AIModelPicker providers={providers} providerID="p1" modelID="gpt-6" onChange={vi.fn()} />);
  const trigger = screen.getByRole("combobox", { name: "选择 AI 模型" });
  fireEvent.click(trigger);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("model popup width follows the trigger width and updates on resize", () => {
  render(<AIModelPicker providers={providers} providerID="p1" modelID="gpt-6" onChange={vi.fn()} />);
  const trigger = screen.getByRole("combobox", { name: "选择 AI 模型" });
  let width = 170;
  vi.spyOn(trigger, "getBoundingClientRect").mockImplementation(() => ({
    x: 24, y: 180, top: 180, left: 24, right: 24 + width, bottom: 210,
    width, height: 30, toJSON: () => ({}),
  }) as DOMRect);

  fireEvent.click(trigger);
  const popup = screen.getByRole("listbox").closest(".ai-dropdown-popover") as HTMLElement;
  expect(popup.style.width).toBe("170px");

  width = 130;
  fireEvent.resize(window);
  expect(popup.style.width).toBe("130px");
});

test("single-model popup does not scroll on hover; overflow enables scrolling only when needed", () => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  let contentHeight = 36;
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return (this as HTMLElement).classList?.contains("ai-dropdown-popover") ? contentHeight : 0;
    },
  });
  const style = document.createElement("style");
  style.textContent = ".ai-dropdown-popover { border-top: 1px solid; border-bottom: 1px solid; }";
  document.head.appendChild(style);

  try {
    render(<AIModelPicker providers={[{ ...providers[0], models: [providers[0].models[0]] }]}
      providerID="p1" modelID="grok-4.7" onChange={vi.fn()} />);
    const trigger = screen.getByRole("combobox", { name: "选择 AI 模型" });
    fireEvent.click(trigger);
    let popup = screen.getByRole("listbox").closest(".ai-dropdown-popover") as HTMLElement;
    expect(popup.style.maxHeight).toBe("39px");
    expect(popup.style.overflowY).toBe("hidden");
    fireEvent.mouseOver(popup);
    expect(popup.style.overflowY).toBe("hidden");

    fireEvent.click(trigger);
    contentHeight = 400;
    fireEvent.click(trigger);
    popup = screen.getByRole("listbox").closest(".ai-dropdown-popover") as HTMLElement;
    expect(popup.style.maxHeight).toBe("260px");
    expect(popup.style.overflowY).toBe("auto");
  } finally {
    style.remove();
    if (descriptor) Object.defineProperty(HTMLElement.prototype, "scrollHeight", descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  }
});
