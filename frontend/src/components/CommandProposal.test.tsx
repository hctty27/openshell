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
