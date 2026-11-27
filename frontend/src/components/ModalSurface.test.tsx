import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useState } from "react";
import ModalSurface from "./ModalSurface";

afterEach(cleanup);

test("opens as a dialog and dismisses via Escape", () => {
  const onDismiss = vi.fn();
  render(<ModalSurface aria-label="Confirm" onDismiss={onDismiss}><button>Cancel</button></ModalSurface>);
  const dialog = screen.getByRole("dialog", { name: "Confirm" });
  expect(dialog.hasAttribute("open")).toBe(true);
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(onDismiss).toHaveBeenCalledOnce();
});

test("non-modal dialogs use show() and leave the background interactive", () => {
  const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "show");
  const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
  const show = vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
  const showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
  Object.defineProperty(HTMLDialogElement.prototype, "show", { configurable: true, value: show });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: showModal });
  const onBackgroundClick = vi.fn();
  try {
    render(
      <>
        <button onClick={onBackgroundClick}>Background action</button>
        <ModalSurface modal={false} aria-label="Editor" onDismiss={vi.fn()}>
          <button>Inside editor</button>
        </ModalSurface>
      </>,
    );
    const dialog = screen.getByRole("dialog", { name: "Editor" });
    expect(show).toHaveBeenCalledOnce();
    expect(showModal).not.toHaveBeenCalled();
    expect(dialog.hasAttribute("aria-modal")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Background action" }));
    expect(onBackgroundClick).toHaveBeenCalledOnce();
  } finally {
    if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, "show", originalShow);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "show");
    if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  }
});

test("locked dialogs cannot be dismissed", () => {
  const onDismiss = vi.fn();
  render(
    <ModalSurface aria-label="Saving" onDismiss={onDismiss} locked>
      <button>Saving</button>
    </ModalSurface>,
  );
  const dialog = screen.getByRole("dialog", { name: "Saving" });
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  fireEvent.click(dialog, { clientX: -10, clientY: -10 });
  expect(onDismiss).not.toHaveBeenCalled();
});

test("backdrop dismisses but clicks inside do not", () => {
  const onDismiss = vi.fn();
  render(
    <ModalSurface aria-label="Editor" onDismiss={onDismiss}>
      <button>Inside</button>
    </ModalSurface>,
  );
  const dialog = screen.getByRole("dialog", { name: "Editor" });
  fireEvent.click(screen.getByRole("button", { name: "Inside" }));
  expect(onDismiss).not.toHaveBeenCalled();
  fireEvent.pointerDown(dialog, { button: 0, clientX: -10, clientY: -10 });
  fireEvent.click(dialog, { clientX: -10, clientY: -10 });
  expect(onDismiss).toHaveBeenCalledOnce();
});

test("dragging a text selection outside the dialog does not dismiss it", () => {
  const onDismiss = vi.fn();
  render(
    <ModalSurface aria-label="Editor" onDismiss={onDismiss}>
      <input aria-label="Host" defaultValue="192.168.1.1" />
    </ModalSurface>,
  );
  const dialog = screen.getByRole("dialog", { name: "Editor" });
  fireEvent.pointerDown(screen.getByRole("textbox", { name: "Host" }), { button: 0 });
  fireEvent.pointerUp(dialog, { clientX: -10, clientY: -10 });
  fireEvent.click(dialog, { clientX: -10, clientY: -10 });
  expect(onDismiss).not.toHaveBeenCalled();
});

test("returns focus to the triggering element on close", () => {
  function Example() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open dialog</button>
        {open && (
          <ModalSurface aria-label="Editor" onDismiss={() => setOpen(false)}>
            <button onClick={() => setOpen(false)}>Done</button>
          </ModalSurface>
        )}
      </>
    );
  }
  render(<Example />);
  const opener = screen.getByRole("button", { name: "Open dialog" });
  opener.focus();
  fireEvent.click(opener);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(document.activeElement).toBe(opener);
});
