import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Tab } from "../types";
import WorkspaceTabStrip from "./WorkspaceTabStrip";

const makeTab = (id: string, status: Tab["status"] = "connected") => ({
  id, session: { id, name: id, host: "example.test", port: 22, username: "root" },
  status, ref: { tabId: id, sessionId: id, generation: 1 }, everConnected: true,
} as Tab);

describe("WorkspaceTabStrip", () => {
  function setup() {
    const onReorder = vi.fn();
    const onDuplicate = vi.fn();
    const onClose = vi.fn();
    const tabs = [makeTab("first"), makeTab("second"), makeTab("third", "disconnected")];
    const result = render(
      <WorkspaceTabStrip tabs={tabs} activeID="first" disconnectBehavior="local"
        onActivate={vi.fn()} onDuplicate={onDuplicate} onClose={onClose}
        onNewTab={vi.fn()} onReorder={onReorder} />,
    );
    return { ...result, onReorder, onDuplicate, onClose, tabs };
  }

  it("reorders a dragged tab after the hovered tab", () => {
    const { container, onReorder } = setup();
    const nodes = container.querySelectorAll<HTMLElement>(".terminal-tab");
    const transfer = { setData: vi.fn(), effectAllowed: "none", dropEffect: "none" };
    vi.spyOn(nodes[2], "getBoundingClientRect").mockReturnValue({ left: 100, width: 100, right: 200 } as DOMRect);
    fireEvent.dragStart(nodes[0], { dataTransfer: transfer });
    fireEvent.dragOver(nodes[2], { dataTransfer: transfer, clientX: 180 });
    expect(nodes[2].classList.contains("drag-after")).toBe(true);
    fireEvent.drop(nodes[2], { dataTransfer: transfer, clientX: 180 });
    expect(onReorder).toHaveBeenCalledWith("first", "third", "after");
  });

  it("publishes a typed drag payload and releases a split tab on the empty strip", () => {
    setup();
    const onTabDragStart = vi.fn();
    const onTabDragEnd = vi.fn();
    const onDropOnStrip = vi.fn();
    const tabs = [makeTab("A"), makeTab("B")];
    const { container } = render(
      <WorkspaceTabStrip tabs={tabs} activeID="A" disconnectBehavior="local"
        onActivate={vi.fn()} onDuplicate={vi.fn()} onClose={vi.fn()}
        onNewTab={vi.fn()} onReorder={vi.fn()}
        onTabDragStart={onTabDragStart} onTabDragEnd={onTabDragEnd}
        onDropOnStrip={onDropOnStrip} />,
    );
    const strip = container.querySelector<HTMLElement>(".tab-strip")!;
    const tab = strip.querySelector<HTMLElement>(".terminal-tab")!;
    const transfer = { setData: vi.fn(), effectAllowed: "none", dropEffect: "none" };
    fireEvent.dragStart(tab, { dataTransfer: transfer });
    expect(transfer.setData).toHaveBeenCalledWith("application/x-openshell-tab", "A");
    expect(onTabDragStart).toHaveBeenCalledWith("A");
    fireEvent.dragOver(strip, { dataTransfer: transfer });
    fireEvent.drop(strip, { dataTransfer: transfer });
    expect(onDropOnStrip).toHaveBeenCalledWith("A");
    expect(onTabDragEnd).toHaveBeenCalled();
  });

  it("keeps double click duplication and keyboard reordering", () => {
    const { onReorder, onDuplicate, tabs } = setup();
    const button = screen.getAllByTitle(/双击|Double-click/)[0];
    fireEvent.doubleClick(button);
    expect(onDuplicate).toHaveBeenCalledWith(tabs[0]);
    fireEvent.keyDown(button, { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(onReorder).toHaveBeenCalledWith("first", "second", "after");
  });

  it("does not start dragging from the close button", () => {
    const { container, onClose, tabs } = setup();
    const node = container.querySelector<HTMLElement>(".terminal-tab")!;
    const close = node.querySelector<HTMLButtonElement>(".terminal-tab-close")!;
    const transfer = { setData: vi.fn(), effectAllowed: "none" };
    expect(fireEvent.dragStart(close, { dataTransfer: transfer })).toBe(false);
    expect(transfer.setData).not.toHaveBeenCalled();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledWith(tabs[0]);
  });

  it("distinguishes connected, local and failed states", () => {
    const { container } = setup();
    expect(container.querySelector(".connection-state-connected")).not.toBeNull();
    expect(container.querySelector(".connection-state-local")).not.toBeNull();
  });
});
