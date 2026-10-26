import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api } from "../../bridge";
import type { Tab } from "../../types";
import type { SplitDropZone } from "./splitDrop";
import {
  addSplitPane, clampRatio, pane, paneIDs, removePane, retainPanes, rotateActiveBranch,
  setSplitNodeRatio, splitGeometry, type SplitHandle, type SplitNode,
} from "./splitTree";

interface Options {
  tabs: Tab[];
  activeID: string;
  showSFTP: boolean;
  initialRatio?: number;
  onError(error: unknown): void;
}

export function useSplitWorkspace({ tabs, activeID, showSFTP, initialRatio, onError }: Options) {
  const [layout, setLayout] = useState<SplitNode | null>(null);
  const [defaultRatio, setDefaultRatio] = useState(clampRatio(initialRatio ?? 50));
  const [size, setSize] = useState({ width: 0, height: 0 });
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  const branchSerial = useRef(0);

  useEffect(() => () => dragCleanup.current?.(), []);
  useEffect(() => {
    const el = splitContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      setSize(previous => previous.width === width && previous.height === height
        ? previous : { width, height });
    });
    observer.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, [tabs.length > 0]);

  useEffect(() => {
    const valid = new Set(tabs.map(tab => tab.id));
    setLayout(previous => retainPanes(previous, valid));
  }, [tabs]);

  const ids = paneIDs(layout);
  const connected = ids.every(id => tabs.some(tab => tab.id === id && tab.status === "connected"));
  const splitReady = Boolean(layout?.type === "split" && ids.includes(activeID) && connected && !showSFTP);
  const displayLayout = splitReady ? layout : activeID ? pane(activeID) : null;
  const visibleTabIDs = paneIDs(displayLayout);
  const geometry = useMemo(() => splitGeometry(displayLayout, size.width, size.height),
    [displayLayout, size.width, size.height]);
  const splitDirection = layout?.type === "split" ? layout.direction : "columns";

  const applyDrop = (sourceID: string, targetID: string, zone: SplitDropZone) => {
    if (showSFTP) return;
    const source = tabs.find(tab => tab.id === sourceID && tab.status === "connected");
    const target = tabs.find(tab => tab.id === targetID && tab.status === "connected");
    if (!source || !target) return;
    const id = `branch-${++branchSerial.current}`;
    setLayout(current => {
      const currentIds = paneIDs(current);
      const base = currentIds.includes(targetID) && currentIds.includes(activeID) && !showSFTP
        ? current : pane(targetID);
      return addSplitPane(base, sourceID, targetID, zone, id, defaultRatio);
    });
  };
  const undockPane = (tabID: string) => setLayout(current => removePane(current, tabID));
  const closeSplit = () => setLayout(null);
  const rotateActiveSplit = () => setLayout(current =>
    current ? rotateActiveBranch(current, activeID) : current);
  const setSplitRatio = (next: number) => setDefaultRatio(clampRatio(next));

  const resizeNodeAndSave = (nodeID: string, value: number) => {
    const ratio = clampRatio(value);
    setLayout(current => current ? setSplitNodeRatio(current, nodeID, ratio) : current);
    if (layout?.type === "split" && layout.id === nodeID) {
      setDefaultRatio(ratio);
      void api.SavePreference("splitRatio", String(ratio)).catch(onError);
    }
  };
  const startSplitResize = (event: ReactPointerEvent<HTMLDivElement>, handle: SplitHandle) => {
    if (event.button !== 0 || !splitReady) return;
    const container = splitContainerRef.current;
    if (!container) return;
    event.preventDefault();
    dragCleanup.current?.();
    const pointerID = event.pointerId;
    const origin = container.getBoundingClientRect();
    const getRatio = (e: PointerEvent) => {
      const columns = handle.direction === "columns";
      const start = columns ? handle.parent.left + origin.left : handle.parent.top + origin.top;
      const parentLength = columns ? handle.parent.width : handle.parent.height;
      const measuredLength = columns ? origin.width : origin.height;
      const length = Math.max(0, (parentLength || measuredLength) - 6);
      if (length <= 0) return handle.ratio;
      const position = (columns ? e.clientX : e.clientY) - start;
      return clampRatio(position * 100 / length);
    };
    let latest = handle.ratio;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerID) return;
      latest = getRatio(e);
      setLayout(current => current ? setSplitNodeRatio(current, handle.id, latest) : current);
    };
    const cleanup = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", cancel);
      dragCleanup.current = null;
    };
    const stop = (e: PointerEvent) => {
      if (e.pointerId !== pointerID) return;
      cleanup();
      resizeNodeAndSave(handle.id, latest);
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId !== pointerID) return;
      cleanup();
      setLayout(current => current ? setSplitNodeRatio(current, handle.id, handle.ratio) : current);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", cancel);
    dragCleanup.current = cleanup;
  };

  return {
    layout, setLayout, splitDirection, splitContainerRef, splitReady,
    visibleTabIDs, paneBoxes: geometry.panes, splitHandles: geometry.handles,
    applyDrop, undockPane, closeSplit, rotateActiveSplit,
    setSplitRatio, resizeNodeAndSave, startSplitResize,
  };
}
