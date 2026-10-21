import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ComponentProps } from "react";
import AISidebar from "./AISidebar";

afterEach(cleanup);
function props(chatBusy = false): ComponentProps<typeof AISidebar> {
  return {
    tab: {
      id: "tab",
      session: {
        id: "session",
        groupId: "",
        name: "test",
        host: "localhost",
        port: 22,
        username: "test",
        authType: "password",
        privateKeyPath: "",
        credentialRef: "",
      },
      ref: null,
      status: "connected",
      home: "/",
      cwd: "/",
      messages: [{ id: "empty", role: "assistant", text: "" }],
      proposal: null,
      chatBusy,
      executing: false,
      error: "",
    },
    profiles: [],
    profileID: "",
    context: "",
    onProfile: vi.fn(),
    onHide: vi.fn(),
    onSettings: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onClear: vi.fn(),
    onPreview: vi.fn(),
    onClearContext: vi.fn(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    onRevise: vi.fn(async () => {}),
  };
}
test("completed empty reply does not keep spinning", () => {
  const { container } = render(<AISidebar {...props()} />);
  expect(container.querySelector(".message-body .spin")).toBeNull();
  expect(screen.getByText("本次回复未返回文本")).toBeTruthy();
});
test("only the current pending reply spins during a later request", () => {
  const p = props(true);
  p.tab!.messages.push({ id: "next", role: "assistant", text: "" });
  const { container } = render(<AISidebar {...p} />);
  expect(container.querySelectorAll(".message-body .spin")).toHaveLength(1);
});
test("current empty reply spins while waiting for API", () => {
  const { container } = render(<AISidebar {...props(true)} />);
  expect(container.querySelectorAll(".message-body .spin")).toHaveLength(1);
});

test("automatic mode sends an automatic task and stays per tab", () => {
  const p = props();
  p.tab!.id = "one";
  p.profiles = [
    {
      id: "api",
      name: "test",
      baseUrl: "https://example.com/v1",
      model: "test",
      secretRef: "",
      toolsEnabled: true,
    },
  ];
  p.profileID = "api";
  const { rerender } = render(<AISidebar {...p} />);
  fireEvent.change(screen.getByLabelText("AI 模式"), {
    target: { value: "auto" },
  });
  fireEvent.change(screen.getByLabelText("发送给 AI"), {
    target: { value: "检查磁盘" },
  });
  fireEvent.click(screen.getByTitle("发送消息"));
  expect(p.onSend).toHaveBeenCalledWith("检查磁盘", "auto", "");
  rerender(<AISidebar {...p} tab={{ ...p.tab!, id: "two" }} />);
  expect((screen.getByLabelText("AI 模式") as HTMLSelectElement).value).toBe(
    "confirm",
  );
});

test("automatic limit exposes explicit continue and stop controls", () => {
  const p = props();
  p.tab!.autoRun = {
    id: "task",
    ref: { tabId: "tab", sessionId: "s", generation: 1 },
    status: "limit",
    steps: 10,
    roundSteps: 10,
    limit: 10,
    allowChanges: false,
    reason: "达到上限",
  };
  p.onAutoContinue = vi.fn();
  render(<AISidebar {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "继续下一轮" }));
  expect(p.onAutoContinue).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByTitle("停止任务"));
  expect(p.onStop).toHaveBeenCalledOnce();
});

test("the model picker sits to the right of the mode selector in the composer", () => {
  const p = props();
  p.profiles = [
    { id: "grok", name: "grok", baseUrl: "https://example.com/v1", model: "grok-4.7(xhigh)", secretRef: "", toolsEnabled: true },
    { id: "gpt", name: "gpt", baseUrl: "https://example.com/v1", model: "gpt-6", secretRef: "", toolsEnabled: true },
  ];
  p.profileID = "grok";
  const { container } = render(<AISidebar {...p} />);
  const mode = screen.getByLabelText("AI 模式");
  const model = screen.getByLabelText("当前模型") as HTMLSelectElement;

  expect(mode.closest(".composer-tools")?.contains(model)).toBe(true);
  expect(mode.nextElementSibling?.contains(model)).toBe(true);
  expect(container.querySelector(".model-picker")).toBeNull();
  expect(model.value).toBe("grok");
  expect(model.title).toBe("grok · grok-4.7(xhigh)");

  fireEvent.change(model, { target: { value: "gpt" } });
  expect(p.onProfile).toHaveBeenCalledWith("gpt");
});

test("model configuration stays available in the composer without profiles", () => {
  const p = props();
  const { container } = render(<AISidebar {...p} />);
  const settings = screen.getByRole("button", { name: "配置模型" });
  expect(settings.closest(".composer-tools")).toBeTruthy();
  expect(container.querySelector(".model-picker")).toBeNull();
  fireEvent.click(settings);
  expect(p.onSettings).toHaveBeenCalledOnce();
});

test("model switching is disabled while an automatic task is active", () => {
  const p = props();
  p.profiles = [
    { id: "grok", name: "grok", baseUrl: "https://example.com/v1", model: "grok-4.7", secretRef: "", toolsEnabled: true },
  ];
  p.profileID = "grok";
  p.tab!.autoRun = {
    id: "task",
    ref: { tabId: "tab", sessionId: "session", generation: 1 },
    status: "running",
    steps: 1,
    roundSteps: 1,
    limit: 10,
    allowChanges: false,
    reason: "",
  };
  render(<AISidebar {...p} />);
  expect((screen.getByLabelText("当前模型") as HTMLSelectElement).disabled).toBe(true);
});
