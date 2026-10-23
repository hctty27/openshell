import { useEffect, useRef } from "react";
import { listen } from "../../bridge";
import type { Ref, SFTPTask } from "../../types";

// Use the full connection identity: events from a previous SSH generation
// must never prevent disconnecting a reconnected tab.
const connectionKey = (ref: Ref) => `${ref.tabId}:${ref.sessionId}:${ref.generation}`;

export function useTransferActivity() {
  const sftpJobs = useRef(new Map<string, Set<string>>());
  const zmodemActive = useRef(new Set<string>());
  const zmodemFinished = useRef(new Set<string>());

  useEffect(() => {
    const offSFTP = listen("sftp:transfer", (task: SFTPTask) => {
      if (!task?.ref) return;
      const key = connectionKey(task.ref);
      const active = sftpJobs.current.get(key) ?? new Set<string>();
      if (task.status === "queued" || task.status === "running") active.add(task.id);
      else active.delete(task.id);
      if (active.size) sftpJobs.current.set(key, active);
      else sftpJobs.current.delete(key);
    });
    const offDetails = listen("ssh:transfer-details", (payload: { ref: Ref }) => {
      if (payload?.ref) zmodemFinished.current.delete(connectionKey(payload.ref));
    });
    const offState = listen("ssh:transfer-state", (payload: { ref: Ref; active: boolean }) => {
      if (!payload?.ref) return;
      const key = connectionKey(payload.ref);
      if (payload.active && !zmodemFinished.current.has(key)) {
        zmodemActive.current.add(key);
      } else if (!payload.active) {
        zmodemActive.current.delete(key);
        zmodemFinished.current.add(key);
      }
    });
    const offFinished = listen("ssh:transfer-finished", (payload: { ref: Ref }) => {
      if (!payload?.ref) return;
      const key = connectionKey(payload.ref);
      zmodemActive.current.delete(key);
      zmodemFinished.current.add(key);
    });
    const offDisconnected = listen("ssh:disconnected", (ref: Ref) => {
      if (!ref?.tabId) return;
      const key = connectionKey(ref);
      sftpJobs.current.delete(key);
      zmodemActive.current.delete(key);
      zmodemFinished.current.delete(key);
    });
    return () => {
      offSFTP();
      offDetails();
      offState();
      offFinished();
      offDisconnected();
    };
  }, []);

  const hasActiveTransfers = (ref: Ref | null | undefined) => {
    if (!ref) return false;
    const key = connectionKey(ref);
    return Boolean(sftpJobs.current.get(key)?.size || zmodemActive.current.has(key));
  };
  return { hasActiveTransfers };
}
