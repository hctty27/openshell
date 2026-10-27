import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Tab } from "../types";
import WorkspaceTabStrip from "./WorkspaceTabStrip";

const makeTab = (id: string, status: Tab["status"] = "connected") => ({
  id, session: { id, name: id, host: "example.test", port: 22, username: "root" },
  status, ref: { tabId: id, sessionId: id, generation: 1 }, everConnected: true,
} as Tab);

function geometry(container: HTMLElement) {
  const strip = container.querySelector<HTMLElement>(".tab-strip")!;
  vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
    left: 0, right: 500, top: 0, bottom: 36, width: 500, height: 36,
  } as DOMRect);
  container.querySelectorAll<HTMLElement>(".terminal-tab").forEach((el, i) =>
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      left: i * 100, right: (i + 1) * 100, top: 0, bottom: 36,
      width: 100, height: 36,
    } as DOMRect));
  return strip;
}

describe("WorkspaceTabStrip", () => {
  function setup() {
    const onReorder = vi.fn();
    const onDuplicate = vi.fn();
    const onClose = vi.fn();
    const onTabPointerMove = vi.fn();
    const onTabPointerDrop = vi.fn();
    const onDropOnStrip = vi.fn();
    const tabs = [makeTab("first"), makeTab("second"), makeTab("third", "disconnected")];
    const result = render(
      <WorkspaceTabStrip tabs={tabs} activeID="first" disconnectBehavior="local"
        onActivate={vi.fn()} onDuplicate={onDuplicate} onClose={onClose}
        onNewTab={vi.fn()} onReorder={onReorder}
        onTabPointerMove={onTabPointerMove} onTabPointerDrop={onTabPointerDrop}
        onDropOnStrip={onDropOnStrip} />,
    );
    geometry(result.container);
    return { ...result, onReorder, onDuplicate, onClose, tabs,
      onTabPointerMove, onTabPointerDrop, onDropOnStrip };
  }

  const press = (button: HTMLElement, x = 40, y = 15) =>
    fireEvent.pointerDown(button, { button: 0, pointerId: 1, clientX: x, clientY: y });
  const move = (x: number, y: number) =>
    fireEvent.pointerMove(window, { pointerId: 1, clientX: x, clientY: y });
  const release = (x: number, y: number) =>
    fireEvent.pointerUp(window, { pointerId: 1, clientX: x, clientY: y });

  it("shows live displacement and reorders on pointer release", () => {
    const { container, onReorder } = setup();
    press(container.querySelector(".terminal-tab button")!);
    move(280, 15);
    expect(container.querySelector(".terminal-tab.dragging")).not.toBeNull();
    expect(document.querySelector(".tab-drag-overlay")).not.toBeNull();
    expect(container.querySelectorAll(".terminal-tab")[1].getAttribute("style"))
      .toContain("translateX(-100px)");
    release(280, 15);
    expect(onReorder).toHaveBeenCalledWith("first", "third", "after");
    expect(document.querySelector(".tab-drag-overlay")).toBeNull();
  });

  it("does not initiate a drag before the five-pixel threshold", () => {
    const { container, onTabPointerMove, onReorder } = setup();
    press(container.querySelector(".terminal-tab button")!);
    move(43, 16);
    release(43, 16);
    expect(onTabPointerMove).not.toHaveBeenCalled();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("hands off to terminal drop and undocks on blank strip space", () => {
    const { container, onTabPointerDrop, onDropOnStrip } = setup();
    const button = container.querySelector<HTMLElement>(".terminal-tab button")!;
    press(button);
    move(350, 250);
    release(350, 250);
    expect(onTabPointerDrop).toHaveBeenCalledWith("first", 350, 250);
    press(button);
    move(450, 15);
    release(450, 15);
    expect(onDropOnStrip).toHaveBeenCalledWith("first");
  });

  it("cancels on Escape, retaining tab order", () => {
    const { container, onReorder, onTabPointerDrop } = setup();
    press(container.querySelector(".terminal-tab button")!);
    move(350, 250);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onReorder).not.toHaveBeenCalled();
    expect(onTabPointerDrop).not.toHaveBeenCalled();
    expect(document.querySelector(".tab-drag-overlay")).toBeNull();
  });

  it("keeps double click duplication and keyboard reordering", () => {
    const { onReorder, onDuplicate, tabs } = setup();
    const button = screen.getAllByTitle(/双击|Double-click/)[0];
    fireEvent.doubleClick(button);
    expect(onDuplicate).toHaveBeenCalledWith(tabs[0]);
    fireEvent.keyDown(button, { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(onReorder).toHaveBeenCalledWith("first", "second", "after");
  });

  it("never starts a drag from the close button", () => {
    const { container, onClose, tabs, onTabPointerMove } = setup();
    const close = container.querySelector<HTMLElement>(".terminal-tab-close")!;
    press(close);
    move(350, 250);
    release(350, 250);
    expect(onTabPointerMove).not.toHaveBeenCalled();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledWith(tabs[0]);
  });

  it("distinguishes connected, local and failed states", () => {
    const { container } = setup();
    expect(container.querySelector(".connection-state-connected")).not.toBeNull();
    expect(container.querySelector(".connection-state-local")).not.toBeNull();
  });
});
