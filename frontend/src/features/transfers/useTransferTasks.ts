import { useEffect, useRef, useState } from "react";
import { api, desktop, listen } from "../../bridge";
import type { Ref, SFTPTask } from "../../types";
import { mergeTransferHistory, sameTransferRef } from "./transferHistory";

interface ZmodemStats { transferred: string; speed: string }

const sameRef = sameTransferRef;

// Owns transfer event subscriptions, hydration and lifecycle state independently
// of the sidebar's rendering and button interactions.
export function useTransferTasks(refID?: Ref) {
  const [tasks, setTasks] = useState<SFTPTask[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [zmodemActive, setZmodemActive] = useState(false);
  const [zmodemCancelling, setZmodemCancelling] = useState(false);
  const [zmodemStats, setZmodemStats] = useState<ZmodemStats | null>(null);
  const seenZmodem = useRef(false);
  const finishedZmodem = useRef(false);
  const currentTransferId = useRef<string | null>(null);
  useEffect(() => {
    let disposed = false;
    setTasks([]);
    setZmodemActive(false);
    setZmodemCancelling(false);
    setZmodemStats(null);
    seenZmodem.current = false;
    finishedZmodem.current = false;
    currentTransferId.current = null;
    if (!refID) return;
    // Browser fixtures can emulate SSH without exposing the SFTP backend.
    // Check the actual Wails binding before calling through the API proxy.
    if (desktop) {
      void api.SFTPTransfers(refID).then(list => {
        if (disposed) return;
        setTasks(current => {
          return mergeTransferHistory((list ?? []).filter(task => sameRef(task.ref, refID)), current);
        });
      }).catch(() => {});
    }
    const offTasks = listen("sftp:transfer", (task: SFTPTask) => {
      if (!sameRef(task.ref, refID)) return;
      setTasks(old => mergeTransferHistory(old, [task]));
      if (task.status === "running" || task.status === "failed") setExpanded(true);
    });
    const offDetails = listen("ssh:transfer-details", (payload: { ref: Ref; transferId?: string }) => {
      if (!sameRef(payload?.ref, refID)) return;
      currentTransferId.current = payload.transferId || "legacy";
      finishedZmodem.current = false;
      seenZmodem.current = true;
      setZmodemActive(true);
      setZmodemCancelling(false);
      setZmodemStats(null);
      setExpanded(true);
    });
    const offState = listen("ssh:transfer-state", (payload: {
      ref: Ref; transferId?: string; active: boolean;
    }) => {
      if (!sameRef(payload?.ref, refID)) return;
      const transferId = payload.transferId || currentTransferId.current || "legacy";
      if (currentTransferId.current && transferId !== currentTransferId.current) return;
      if (!currentTransferId.current) currentTransferId.current = transferId;
      if (payload.active && finishedZmodem.current) return;
      if (!payload.active) finishedZmodem.current = true;
      setZmodemActive(payload.active);
      setZmodemCancelling(false);
      setZmodemStats(null);
      if (payload.active) {
        seenZmodem.current = true;
        setExpanded(true);
      } else if (seenZmodem.current) {
        seenZmodem.current = false;
      }
    });
    const offProgress = listen("ssh:transfer-progress", (payload: {
      ref: Ref; transferId?: string; transferred: string; speed: string;
    }) => {
      if (!sameRef(payload?.ref, refID)) return;
      const transferId = payload.transferId || currentTransferId.current || "legacy";
      if (currentTransferId.current && transferId !== currentTransferId.current) return;
      if (finishedZmodem.current) return;
      setZmodemStats({ transferred: payload.transferred, speed: payload.speed });
    });
    // Upstream legacy ZMODEM may delay its transfer-state(false) callback
    // until more remote output arrives after the local child has already exited.
    const offFinished = listen("ssh:transfer-finished", (payload: { ref: Ref; transferId?: string }) => {
      if (!sameRef(payload?.ref, refID)) return;
      const transferId = payload.transferId || currentTransferId.current || "legacy";
      if (currentTransferId.current && transferId !== currentTransferId.current) return;
      finishedZmodem.current = true;
      seenZmodem.current = false;
      setZmodemActive(false);
      setZmodemCancelling(false);
      setZmodemStats(null);
    });
    const offDisconnected = listen("ssh:disconnected", (ref: Ref) => {
      if (!sameRef(ref, refID)) return;
      currentTransferId.current = null;
      finishedZmodem.current = false;
      seenZmodem.current = false;
      setZmodemActive(false);
      setZmodemCancelling(false);
      setZmodemStats(null);
    });
    return () => {
      disposed = true;
      offTasks();
      offDetails();
      offState();
      offProgress();
      offFinished();
      offDisconnected();
    };
  }, [refID?.tabId, refID?.sessionId, refID?.generation]);


  return {
    tasks, expanded, setExpanded, zmodemActive,
    zmodemCancelling, setZmodemCancelling, zmodemStats,
  };
}
