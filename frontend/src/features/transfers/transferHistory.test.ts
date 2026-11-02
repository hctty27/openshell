import { expect, test } from "vitest";
import type { Ref, SFTPTask } from "../../types";
import { maxFinishedTransferHistory, mergeTransferHistory, sameTransferRef } from "./transferHistory";

const ref: Ref = { tabId: "tab", sessionId: "server", generation: 2 };
const makeTask = (created: number, status: SFTPTask["status"] = "completed"): SFTPTask => ({
  id: String(created), ref, direction: "upload", source: "/source",
  destination: "/destination", name: "file", bytes: 1, total: 1,
  status, overwrite: false, resume: true, error: "", created,
});

test("transfer history bounds completed, failed and cancelled tasks", () => {
  const statuses: SFTPTask["status"][] = ["completed", "failed", "cancelled"];
  const finished = Array.from({ length: maxFinishedTransferHistory + 12 }, (_, i) =>
    makeTask(i, statuses[i % statuses.length]));
  const result = mergeTransferHistory([], finished);
  expect(result).toHaveLength(maxFinishedTransferHistory);
  expect(result[0].id).toBe("12");
  expect(result.at(-1)?.id).toBe(String(maxFinishedTransferHistory + 11));
});

test("all running and queued tasks survive cleanup, even past the history limit", () => {
  const finished = Array.from({ length: 250 }, (_, i) => makeTask(i));
  const running = Array.from({ length: 220 }, (_, i) => makeTask(i + 250, i % 2 ? "queued" : "running"));
  const result = mergeTransferHistory(finished, running);
  expect(result).toHaveLength(maxFinishedTransferHistory + running.length);
  expect(result.filter(task => task.status === "queued" || task.status === "running")).toHaveLength(running.length);
  expect(result.find(task => task.id === "0")).toBeUndefined();
});

test("event updates override older server snapshots without duplicating jobs", () => {
  const snapshot = makeTask(10, "running");
  const completed = { ...snapshot, status: "completed" as const, bytes: 42 };
  const result = mergeTransferHistory([snapshot], [completed]);
  expect(result).toHaveLength(1);
  expect(result[0]).toEqual(completed);
});

test("transfer refs must match tab, session and generation", () => {
  expect(sameTransferRef(ref, { ...ref })).toBe(true);
  expect(sameTransferRef(ref, { ...ref, tabId: "other" })).toBe(false);
  expect(sameTransferRef(ref, { ...ref, sessionId: "other" })).toBe(false);
  expect(sameTransferRef(ref, { ...ref, generation: 3 })).toBe(false);
  expect(sameTransferRef(ref, undefined)).toBe(false);
});
