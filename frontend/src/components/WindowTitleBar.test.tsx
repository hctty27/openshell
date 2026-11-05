import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Window } from "@wailsio/runtime";
import WindowTitleBar from "./WindowTitleBar";

vi.mock("@wailsio/runtime", () => ({
  Window: {
    IsMaximised: vi.fn(async () => false),
    Close: vi.fn(async () => {}),
    Minimise: vi.fn(async () => {}),
    Maximise: vi.fn(async () => {}),
    Restore: vi.fn(async () => {}),
  },
}));
vi.mock("../bridge", () => ({ nativeDesktop: true }));
vi.mock("./TransferCenter", () => ({ default: () => null }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("title bar displays the bundled OpenShell logo", () => {
  const { container } = render(
    <WindowTitleBar tabs={[]} onSettings={vi.fn()} onNotice={vi.fn()} />,
  );

  const logo = container.querySelector<HTMLImageElement>(".window-titlebar-brand img");
  expect(logo?.getAttribute("src")).toBe("/app-icon.svg");
  expect(logo?.getAttribute("alt")).toBe("");
  expect(container.querySelector(".window-titlebar-brand svg")).toBeNull();
});

test("custom close button uses native Window.Close so Go can intercept WindowClosing", async () => {
  const onNotice = vi.fn();
  const { container } = render(
    <WindowTitleBar tabs={[]} onSettings={vi.fn()} onNotice={onNotice} />,
  );
  const close = container.querySelector<HTMLButtonElement>(".window-control-close");
  expect(close).not.toBeNull();

  fireEvent.click(close!);

  await waitFor(() => expect(Window.Close).toHaveBeenCalledTimes(1));
  expect(onNotice).not.toHaveBeenCalled();
});

test("custom close button reports Wails close failures", async () => {
  vi.mocked(Window.Close).mockRejectedValueOnce(new Error("close unavailable"));
  const onNotice = vi.fn();
  const { container } = render(
    <WindowTitleBar tabs={[]} onSettings={vi.fn()} onNotice={onNotice} />,
  );

  fireEvent.click(container.querySelector<HTMLButtonElement>(".window-control-close")!);

  await waitFor(() => expect(onNotice).toHaveBeenCalledWith(
    expect.objectContaining({ message: "close unavailable" }),
  ));
});
