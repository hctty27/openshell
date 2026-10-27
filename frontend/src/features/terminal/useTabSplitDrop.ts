import { useState, type RefObject } from "react";
import { t } from "../../i18n";
import type { Tab } from "../../types";
import { getSplitDropIntent, type SplitDropIntent, type SplitDropZone } from "./splitDrop";
import { MAX_SPLIT_PANES, paneIDs, type SplitNode } from "./splitTree";

interface Options {
  tabs: Tab[];
  layout: SplitNode | null;
  splitContainerRef: RefObject<HTMLDivElement | null>;
  showSFTP: boolean;
  applyDrop(sourceID: string, targetID: string, zone: SplitDropZone): void;
  setActiveID(id: string): void;
  onError(error: unknown): void;
}

export function useTabSplitDrop({
  tabs, layout, splitContainerRef, showSFTP, applyDrop, setActiveID, onError,
}: Options) {
  const [splitDropPreview, setSplitDropPreview] = useState<{
    targetID: string;
    intent: SplitDropIntent;
    invalid: boolean;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  const findPointerDrop = (sourceID: string, x: number, y: number): {
    targetID: string;
    intent: SplitDropIntent;
    invalid: boolean;
    bounds: DOMRect;
  } | null => {
    const container = splitContainerRef.current;
    if (!container || showSFTP) return null;
    const source = tabs.find(tab => tab.id === sourceID && tab.status === "connected");
    if (!source) return null;
    const targetPane = Array.from(container.querySelectorAll<HTMLElement>(".terminal-pane.visible"))
      .find(element => {
        const rect = element.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      });
    if (!targetPane) return null;
    const targetID = targetPane.dataset.tabId ?? "";
    if (sourceID === targetID || !tabs.some(tab => tab.id === targetID && tab.status === "connected"))
      return null;
    const bounds = targetPane.getBoundingClientRect();
    const previous = splitDropPreview?.targetID === targetID ? splitDropPreview.intent : undefined;
    const intent = getSplitDropIntent(bounds, x, y, previous);
    const existing = paneIDs(layout);
    const invalid = !existing.includes(sourceID) && existing.length >= MAX_SPLIT_PANES;
    return { targetID, intent, invalid, bounds };
  };

  const onTabPointerMove = (sourceID: string, x: number, y: number) => {
    const target = findPointerDrop(sourceID, x, y);
    const container = splitContainerRef.current;
    if (!target || !container) {
      setSplitDropPreview(null);
      return;
    }
    const outer = container.getBoundingClientRect();
    const next = {
      targetID: target.targetID, intent: target.intent, invalid: target.invalid,
      left: target.bounds.left - outer.left, top: target.bounds.top - outer.top,
      width: target.bounds.width, height: target.bounds.height,
    };
    setSplitDropPreview(previous =>
      previous && previous.targetID === next.targetID &&
      previous.intent.zone === next.intent.zone && previous.intent.mode === next.intent.mode &&
      previous.invalid === next.invalid && previous.left === next.left &&
      previous.top === next.top && previous.width === next.width && previous.height === next.height
        ? previous : next);
  };

  const onTabPointerDrop = (sourceID: string, x: number, y: number) => {
    const target = findPointerDrop(sourceID, x, y);
    if (!target) return;
    if (target.invalid) {
      onError(t("terminal:splitPaneLimit"));
      return;
    }
    applyDrop(sourceID, target.targetID, target.intent.zone);
    setActiveID(target.targetID);
  };

  const clearDropPreview = () => setSplitDropPreview(null);
  return { splitDropPreview, onTabPointerMove, onTabPointerDrop, clearDropPreview };
}
