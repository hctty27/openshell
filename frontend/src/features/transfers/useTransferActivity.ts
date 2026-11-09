import { useEffect, useRef } from "react";
import { listen } from "../../bridge";
import type { Ref, SFTPTask } from "../../types";

// Use the full connection identity: events from a previous SSH generation
// must never prevent disconnecting a reconnected tab.
const connectionKey = (ref: Ref) => `${ref.tabId}:${ref.sessionId}:${ref.generation}`;

export function useTransferActivity() {
  const sftpJobs = useRef(new Map<string, Set<string>>());
  const zmodemActive = useRef(new Set<string>());
  const zmodemFinished = useRef(new Map<string, string>());
  const currentTransferIds = useRef(new Map<string, string>());

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
    const offDetails = listen("ssh:transfer-details", (payload: { ref: Ref; transferId?: string }) => {
      if (!payload?.ref) return;
      const key = connectionKey(payload.ref);
      currentTransferIds.current.set(key, payload.transferId || "legacy");
      zmodemFinished.current.delete(key);
    });
    const offState = listen("ssh:transfer-state", (payload: {
      ref: Ref; transferId?: string; active: boolean;
    }) => {
      if (!payload?.ref) return;
      const key = connectionKey(payload.ref);
      const transferId = payload.transferId || currentTransferIds.current.get(key) || "legacy";
      const currentTransferId = currentTransferIds.current.get(key);
      if (currentTransferId && transferId !== currentTransferId) return;
      if (payload.active && zmodemFinished.current.get(key) !== transferId) {
        zmodemActive.current.add(key);
      } else if (!payload.active) {
        zmodemActive.current.delete(key);
        zmodemFinished.current.set(key, transferId);
      }
    });
    const offFinished = listen("ssh:transfer-finished", (payload: { ref: Ref; transferId?: string }) => {
      if (!payload?.ref) return;
      const key = connectionKey(payload.ref);
      const transferId = payload.transferId || currentTransferIds.current.get(key) || "legacy";
      const currentTransferId = currentTransferIds.current.get(key);
      if (currentTransferId && transferId !== currentTransferId) return;
      zmodemActive.current.delete(key);
      zmodemFinished.current.set(key, transferId);
    });
    const offDisconnected = listen("ssh:disconnected", (ref: Ref) => {
      if (!ref?.tabId) return;
      const key = connectionKey(ref);
      sftpJobs.current.delete(key);
      zmodemActive.current.delete(key);
      zmodemFinished.current.delete(key);
      currentTransferIds.current.delete(key);
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
