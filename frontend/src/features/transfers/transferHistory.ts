import type { Ref, SFTPTask } from "../../types";

export const maxFinishedTransferHistory = 200;

export function sameTransferRef(left: Ref | null | undefined, right: Ref | null | undefined): boolean {
  return Boolean(left && right && left.tabId === right.tabId &&
    left.sessionId === right.sessionId && left.generation === right.generation);
}

const isActive = (task: SFTPTask) => task.status === "queued" || task.status === "running";
const byCreated = (left: SFTPTask, right: SFTPTask) =>
  left.created - right.created || left.id.localeCompare(right.id);

// Keep all active jobs and only the newest 200 ended jobs, even when the panel
// remains mounted through thousands of transfers.
export function mergeTransferHistory(previous: readonly SFTPTask[], updates: readonly SFTPTask[]): SFTPTask[] {
  const byID = new Map<string, SFTPTask>();
  for (const task of previous) byID.set(task.id, task);
  for (const task of updates) byID.set(task.id, task);

  const tasks = [...byID.values()];
  const finished = tasks.filter(task => !isActive(task)).sort(byCreated);
  const recent = new Set(finished.slice(-maxFinishedTransferHistory).map(task => task.id));
  return tasks.filter(task => isActive(task) || recent.has(task.id)).sort(byCreated);
}
