import { beforeEach, afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initializeI18n } from "../i18n";
import type { OperationStep } from "../types";
import OperationTimeline from "./OperationTimeline";

beforeEach(() => initializeI18n("zh-CN"));
afterEach(cleanup);

function step(status: OperationStep["status"]): OperationStep {
  return {
    id: "proposal-one",
    conversationId: "conversation",
    runId: "run",
    sequence: 1,
    command: "supervisorctl · abcd1234",
    targets: [{ tabId: "one", sessionId: "srv", generation: 1 }],
    risk: "high",
    status,
    verificationStatus: "pending",
    createdAt: "2026-10-27T14:00:00Z",
    updatedAt: "2026-10-27T14:01:00Z",
  };
}

test("shows per-server operation history and requires inspection after interruption", () => {
  render(<OperationTimeline steps={[step("unknown")]} />);
  fireEvent.click(screen.getByText(/运维任务记录/));
  expect(screen.getByText(/结果未知/)).toBeTruthy();
  expect(screen.getByText(/不会自动重试/)).toBeTruthy();
  expect(screen.getByText(/one/)).toBeTruthy();
  expect(screen.queryByText(/重试执行/)).toBeNull();
});

test("no operation history leaves chat unchanged", () => {
  const { container } = render(<OperationTimeline steps={[]} />);
  expect(container.querySelector(".ops-timeline")).toBeNull();
});
