import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { initializeI18n } from "../../i18n";
import type { Tab } from "../../types";
import { addSplitPane, pane } from "./splitTree";
import { useTabSplitDrop } from "./useTabSplitDrop";

beforeEach(() => initializeI18n("zh-CN"));
afterEach(cleanup);

function setup(layout = pane("A")) {
  const container = document.createElement("div");
  const target = document.createElement("div");
  target.className = "terminal-pane visible";
  target.dataset.tabId = "A";
  target.getBoundingClientRect = () => ({
    left: 100, top: 100, right: 500, bottom: 400, width: 400, height: 300,
    x: 100, y: 100, toJSON: () => ({}),
  });
  container.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600,
    x: 0, y: 0, toJSON: () => ({}),
  });
  container.appendChild(target);
  const applyDrop = vi.fn();
  const setActiveID = vi.fn();
  const onError = vi.fn();
  const props = {
    tabs: [{ id: "A", status: "connected" }, { id: "B", status: "connected" }] as Tab[],
    layout,
    splitContainerRef: { current: container },
    showSFTP: false,
    applyDrop, setActiveID, onError,
  };
  return { props, applyDrop, setActiveID, onError };
}

test("preview follows pane edge and drops onto the intended connected tab", () => {
  const { props, applyDrop, setActiveID } = setup();
  const { result } = renderHook(() => useTabSplitDrop(props));
  act(() => result.current.onTabPointerMove("B", 105, 250));
  expect(result.current.splitDropPreview).toMatchObject({
    targetID: "A",
    intent: { zone: "left", mode: "edge" },
    invalid: false,
  });
  act(() => result.current.onTabPointerDrop("B", 105, 250));
  expect(applyDrop).toHaveBeenCalledWith("B", "A", "left");
  expect(setActiveID).toHaveBeenCalledWith("A");
  act(() => result.current.clearDropPreview());
  expect(result.current.splitDropPreview).toBeNull();
});

test("rejects a fifth pane without changing layout", () => {
  let layout = addSplitPane(pane("A"), "C", "A", "right", "split-1");
  layout = addSplitPane(layout, "D", "A", "bottom", "split-2");
  layout = addSplitPane(layout, "E", "A", "right", "split-3");
  if (!layout) throw new Error("Unable to construct the four-pane fixture");
  const { props, applyDrop, onError } = setup(layout);
  const { result } = renderHook(() => useTabSplitDrop(props));
  act(() => result.current.onTabPointerMove("B", 105, 250));
  expect(result.current.splitDropPreview?.invalid).toBe(true);
  act(() => result.current.onTabPointerDrop("B", 105, 250));
  expect(onError).toHaveBeenCalledOnce();
  expect(applyDrop).not.toHaveBeenCalled();
});

test("SFTP mode prevents tab-to-terminal split drops", () => {
  const { props, applyDrop } = setup();
  const { result } = renderHook(() => useTabSplitDrop({ ...props, showSFTP: true }));
  act(() => result.current.onTabPointerMove("B", 105, 250));
  expect(result.current.splitDropPreview).toBeNull();
  act(() => result.current.onTabPointerDrop("B", 105, 250));
  expect(applyDrop).not.toHaveBeenCalled();
});
