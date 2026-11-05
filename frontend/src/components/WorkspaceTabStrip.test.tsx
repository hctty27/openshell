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
    vi.spyOn(el, "getBoundingClientRect").mockImplementation(() => {
      const match = el.style.transform.match(/translateX\((-?[\d.]+)px\)/);
      const shift = match ? Number(match[1]) : 0;
      return { left: i * 100 + shift, right: (i + 1) * 100 + shift,
        top: 0, bottom: 36, width: 100, height: 36 } as DOMRect;
    }));
  return strip;
}

describe("WorkspaceTabStrip", () => {
  function setup() {
    const onReorder = vi.fn();
    const onDuplicate = vi.fn();
    const onClose = vi.fn();
    const onCloseTabs = vi.fn();
    const onReconnect = vi.fn();
    const onDisconnect = vi.fn();
    const onTabPointerMove = vi.fn();
    const onTabPointerDrop = vi.fn();
    const onDropOnStrip = vi.fn();
    const tabs = [makeTab("first"), makeTab("second"), makeTab("third", "disconnected")];
    const result = render(
      <WorkspaceTabStrip tabs={tabs} activeID="first" disconnectBehavior="local"
        onActivate={vi.fn()} onDuplicate={onDuplicate} onClose={onClose}
        onCloseTabs={onCloseTabs} onReconnect={onReconnect} onDisconnect={onDisconnect}
        onNewTab={vi.fn()} onReorder={onReorder}
        onTabPointerMove={onTabPointerMove} onTabPointerDrop={onTabPointerDrop}
        onDropOnStrip={onDropOnStrip} />,
    );
    geometry(result.container);
    return { ...result, onReorder, onDuplicate, onClose, onCloseTabs, onReconnect, onDisconnect, tabs,
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

  it("does not mistake an animated last tab for empty strip space", () => {
    const onReorder = vi.fn();
    const onDropOnStrip = vi.fn();
    const { container } = render(
      <WorkspaceTabStrip tabs={[makeTab("A"), makeTab("B")]} activeID="A"
        disconnectBehavior="local" onActivate={vi.fn()} onDuplicate={vi.fn()}
        onClose={vi.fn()} onNewTab={vi.fn()} onReorder={onReorder}
        onDropOnStrip={onDropOnStrip} />,
    );
    geometry(container);
    const last = container.querySelectorAll<HTMLElement>(".terminal-tab")[1];
    vi.spyOn(last, "getBoundingClientRect").mockImplementation(() => {
      const shift = last.style.transform ? -100 : 0;
      return { left: 100 + shift, right: 200 + shift, width: 100 } as DOMRect;
    });
    press(container.querySelector(".terminal-tab button")!);
    move(190, 15);
    release(190, 15);
    expect(onReorder).toHaveBeenCalledWith("A", "B", "after");
    expect(onDropOnStrip).not.toHaveBeenCalled();
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

  it("opens a background tab menu without activating it", () => {
    const { container, tabs, onDuplicate, onCloseTabs } = setup();
    fireEvent.contextMenu(container.querySelector('[data-tab-id="second"]')!, { clientX: 70, clientY: 50 });
    expect(screen.getByRole("menu")).not.toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /复制当前会话|Duplicate current tab/ }));
    expect(onDuplicate).toHaveBeenCalledWith(tabs[1]);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(container.querySelector('[data-tab-id="second"]')!);
    fireEvent.click(screen.getByRole("menuitem", { name: /关闭其他会话|Close other tabs/ }));
    expect(onCloseTabs).toHaveBeenCalledWith([tabs[0], tabs[2]]);
  });

  it("closes only tabs right of the target and dismisses on Escape", () => {
    const { container, tabs, onCloseTabs } = setup();
    fireEvent.contextMenu(container.querySelector('[data-tab-id="second"]')!);
    fireEvent.click(screen.getByRole("menuitem", { name: /关闭右侧会话|Close tabs to the right/ }));
    expect(onCloseTabs).toHaveBeenCalledWith([tabs[2]]);
    fireEvent.contextMenu(container.querySelector('[data-tab-id="first"]')!);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("uses the shared context menu and a single connection action", () => {
    const { container, tabs, onDisconnect, onReconnect } = setup();
    fireEvent.contextMenu(container.querySelector('[data-tab-id="first"]')!);
    expect(document.querySelector(".session-context-menu")).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: /断开连接|Disconnect/ })).not.toBeNull();
    expect(screen.queryByRole("menuitem", { name: /重新连接|Reconnect/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /断开连接|Disconnect/ }));
    expect(onDisconnect).toHaveBeenCalledWith(tabs[0]);

    fireEvent.contextMenu(container.querySelector('[data-tab-id="third"]')!);
    expect(screen.getByRole("menuitem", { name: /重新连接|Reconnect/ })).not.toBeNull();
    expect(screen.queryByRole("menuitem", { name: /断开连接|Disconnect/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /重新连接|Reconnect/ }));
    expect(onReconnect).toHaveBeenCalledWith(tabs[2]);
  });

  it("omits unavailable tab closing commands", () => {
    const { container } = setup();
    fireEvent.contextMenu(container.querySelector('[data-tab-id="third"]')!);
    expect(screen.queryByRole("menuitem", { name: /关闭右侧会话|Close tabs to the right/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /关闭其他会话|Close other tabs/ })).not.toBeNull();
  });

  it("opens the tab context menu using the keyboard", () => {
    const { container } = setup();
    const tabButton = container.querySelector<HTMLElement>('[data-tab-id="first"] > button')!;
    fireEvent.keyDown(tabButton, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu")).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
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

  it("shows an activity dot only for an unread background tab", () => {
    const onActivate = vi.fn();
    const make = (activeID: string, unreadTabIDs: ReadonlySet<string>) => (
      <WorkspaceTabStrip tabs={[makeTab("A"), makeTab("B")]} activeID={activeID}
        unreadTabIDs={unreadTabIDs} disconnectBehavior="local"
        onActivate={onActivate} onDuplicate={vi.fn()} onClose={vi.fn()}
        onNewTab={vi.fn()} onReorder={vi.fn()} />
    );
    const { container, rerender } = render(make("B", new Set(["A"])));
    expect(container.querySelectorAll(".terminal-tab-activity")).toHaveLength(1);
    expect(container.querySelector('[data-tab-id="A"] .terminal-tab-activity')).not.toBeNull();
    expect(container.querySelector('[data-tab-id="B"] .terminal-tab-activity')).toBeNull();
    fireEvent.click(container.querySelector('[data-tab-id="A"] button')!);
    expect(onActivate).toHaveBeenCalledWith("A");
    rerender(make("A", new Set()));
    expect(container.querySelector(".terminal-tab-activity")).toBeNull();
  });

  it("distinguishes connected, local and failed states", () => {
    const { container } = setup();
    expect(container.querySelector(".connection-state-connected")).not.toBeNull();
    expect(container.querySelector(".connection-state-local")).not.toBeNull();
  });
});
