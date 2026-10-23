import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api } from "../../bridge";
import type { Tab } from "../../types";

type SplitDirection = "columns" | "rows";

interface Options {
  tabs: Tab[];
  activeID: string;
  showSFTP: boolean;
  initialRatio?: number;
  onError(error: unknown): void;
}

export function useSplitWorkspace({ tabs, activeID, showSFTP, initialRatio, onError }: Options) {
  const [splitPair, setSplitPair] = useState<[string, string] | null>(null);
  const [splitDirection, setSplitDirection] = useState<SplitDirection>("columns");
  const [splitRatio, setSplitRatio] = useState(Math.min(80, Math.max(20, initialRatio ?? 50)));
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const splitDragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => splitDragCleanup.current?.(), []);

  const splitReady = Boolean(
    !showSFTP && splitPair?.includes(activeID) &&
    splitPair.every((id) => tabs.some((tab) => tab.id === id && tab.status === "connected")),
  );
  const splitPartnerID = splitReady ? (splitPair?.find((id) => id !== activeID) ?? "") : "";
  const splitChoices = tabs.filter((tab) => tab.id !== activeID && tab.status === "connected");
  const setSplitRatioAndSave = (next: number) => {
    const ratio = Math.round(Math.max(20, Math.min(80, next)));
    setSplitRatio(ratio);
    void api.SavePreference("splitRatio", String(ratio)).catch(onError);
  };
  const startSplitResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !splitReady) return;
    const element = splitContainerRef.current;
    if (!element) return;
    event.preventDefault();
    splitDragCleanup.current?.();
    const pointerId = event.pointerId;
    const ratioFromEvent = (e: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      const length = splitDirection === "columns" ? rect.width : rect.height;
      if (length <= 0) return null;
      const position = splitDirection === "columns" ? e.clientX - rect.left : e.clientY - rect.top;
      return Math.round(Math.max(20, Math.min(80, position * 100 / length)));
    };
    let latest = splitRatio;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const next = ratioFromEvent(e);
      if (next === null) return;
      latest = next;
      setSplitRatio(next);
    };
    const cleanup = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", cancel);
      splitDragCleanup.current = null;
    };
    const stop = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      cleanup();
      setSplitRatioAndSave(latest);
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      cleanup();
      setSplitRatio(splitRatio);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", cancel);
    splitDragCleanup.current = cleanup;
  };

  return {
    splitPair, setSplitPair, splitDirection, setSplitDirection,
    splitRatio, setSplitRatio, splitContainerRef, splitReady, splitPartnerID, splitChoices,
    setSplitRatioAndSave, startSplitResize,
  };
}
