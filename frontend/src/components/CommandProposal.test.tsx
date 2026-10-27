import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initializeI18n } from "../i18n";
import type { ComponentProps } from "react";
import CommandProposal from "./CommandProposal";

beforeEach(() => initializeI18n("zh-CN"));
afterEach(cleanup);

function props(risk: "high" | "read"): ComponentProps<typeof CommandProposal> {
  return {
    proposal: {
      id: "proposal-1",
      ref: { tabId: "tab1", sessionId: "host1", generation: 1 },
      command: risk === "high" ? "supervisorctl stop all" : "supervisorctl status",
      cwd: "/",
      purpose: "check",
      status: "awaiting_confirmation",
      timeoutSeconds: 60,
      plan: {
        risk,
        requiresConfirmation: risk === "high",
        preflight: ["target", "environment", "rollback"],
        verificationRequired: risk === "high",
      },
    },
    host: "10.0.1.7",
    username: "root",
    executing: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    onRevise: vi.fn(async () => {}),
  };
}

test("high risk cannot be confirmed until preflight is acknowledged", () => {
  const p = props("high");
  const { container } = render(<CommandProposal {...p} />);
  const confirm = container.querySelector(".proposal-actions .primary") as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  expect(screen.getByText(/回滚方案/)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  expect(p.onConfirm).toHaveBeenCalledOnce();
});

test("read-only inspection remains confirmable without disruptive preflight", () => {
  const p = props("read");
  const { container } = render(<CommandProposal {...p} />);
  expect(screen.queryByRole("checkbox")).toBeNull();
  const confirm = container.querySelector(".proposal-actions .primary") as HTMLButtonElement;
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  expect(p.onConfirm).toHaveBeenCalledOnce();
});

test("high-risk review can inspect fixed SSH probes without granting approval", async () => {
  const p = props("high");
  p.onPreflight = vi.fn(async () => ({
    proposalId: "proposal-1",
    checkedAt: "2026-10-27T00:00:00Z",
    ready: true,
    checks: [
      { ref: { tabId: "tab1", sessionId: "host1", generation: 1 }, key: "identity" as const, status: "passed" as const },
      { ref: { tabId: "tab1", sessionId: "host1", generation: 1 }, key: "capacity" as const, status: "warning" as const },
    ],
  }));
  const { container } = render(<CommandProposal {...p} />);
  fireEvent.click(screen.getByText("检查服务器（只读）"));
  expect(await screen.findByText(/基础探针完成/)).toBeTruthy();
  expect(screen.getByText(/不能替代人工批准/)).toBeTruthy();
  expect(container.querySelector<HTMLButtonElement>(".proposal-actions .primary")!.disabled).toBe(true);
  expect(p.onConfirm).not.toHaveBeenCalled();
});

test("read-only proposal does not show high-risk preflight action", () => {
  const p = props("read");
  p.onPreflight = vi.fn(async () => ({ proposalId:"proposal-1",checkedAt:"",ready:true,checks:[] }));
  render(<CommandProposal {...p} />);
  expect(screen.queryByText("检查服务器（只读）")).toBeNull();
});
