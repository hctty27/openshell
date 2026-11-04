import { describe, expect, it } from "vitest";
import { setTerminalSearchState, toggleTerminalSearchOpen } from "./searchState";

describe("terminal search state", () => {
  it("does not open search in a newly duplicated tab", () => {
    const original = toggleTerminalSearchOpen({}, "tab-a");
    expect(original).toEqual({ "tab-a": true });
    expect(original["tab-b"]).toBeUndefined();
  });

  it("keeps searches independent for tabs using the same SSH session", () => {
    const original = setTerminalSearchState({}, "tab-a", true);
    const bothOpen = setTerminalSearchState(original, "tab-b", true);
    const afterClosingA = setTerminalSearchState(bothOpen, "tab-a", false);

    expect(original).toEqual({ "tab-a": true });
    expect(bothOpen).toEqual({ "tab-a": true, "tab-b": true });
    expect(afterClosingA).toEqual({ "tab-b": true });
  });

  it("toggles toolbar state and ignores redundant close events", () => {
    const opened = toggleTerminalSearchOpen({}, "tab-a");
    const closed = toggleTerminalSearchOpen(opened, "tab-a");

    expect(closed).toEqual({});
    expect(setTerminalSearchState(closed, "tab-a", false)).toBe(closed);
  });
});
