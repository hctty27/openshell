import { useEffect, useRef } from "react";
import { listen } from "../../bridge";
import type { Ref, SFTPTask } from "../../types";

// Use the full connection identity: events from a previous SSH generation
// must never prevent disconnecting a reconnected tab.
const connectionKey = (ref: Ref) => `${ref.tabId}:${ref.sessionId}:${ref.generation}`;

export function useTransferActivity() {
  const sftpJobs = useRef(new Map<string, Set<string>>());
  const nativeZmodemActive = useRef(new Map<string, string>());

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
    const offNative = listen("ssh:native-zmodem-batch", (payload: {
      ref: Ref; id: string; active: boolean;
    }) => {
      if (!payload?.ref || !payload.id) return;
      const key = connectionKey(payload.ref);
      if (payload.active) nativeZmodemActive.current.set(key, payload.id);
      else if (nativeZmodemActive.current.get(key) === payload.id) nativeZmodemActive.current.delete(key);
    });
    const offDisconnected = listen("ssh:disconnected", (ref: Ref) => {
      if (!ref?.tabId) return;
      const key = connectionKey(ref);
      sftpJobs.current.delete(key);
      nativeZmodemActive.current.delete(key);
    });
    return () => {
      offSFTP();
      offNative();
      offDisconnected();
    };
  }, []);

  const hasActiveTransfers = (ref: Ref | null | undefined) => {
    if (!ref) return false;
    const key = connectionKey(ref);
    return Boolean(sftpJobs.current.get(key)?.size || nativeZmodemActive.current.has(key));
  };
  return { hasActiveTransfers };
}
