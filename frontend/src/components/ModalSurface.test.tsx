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
  fireEvent.click(dialog, { clientX: -10, clientY: -10 });
  expect(onDismiss).toHaveBeenCalledOnce();
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
