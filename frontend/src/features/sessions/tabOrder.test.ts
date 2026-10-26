import { describe, expect, it } from "vitest";
import { reorderTabs } from "./tabOrder";

describe("reorderTabs", () => {
  const first = { id: "one", session: "same", ref: { generation: 1 } };
  const second = { id: "two", session: "same", ref: { generation: 2 } };
  const third = { id: "three", session: "other", ref: { generation: 3 } };
  const tabs = [first, second, third];

  it("moves to the beginning without cloning a session or reference", () => {
    const next = reorderTabs(tabs, "three", "one", "before");
    expect(next).toEqual([third, first, second]);
    expect(next[0]).toBe(third);
    expect(next[0].ref).toBe(third.ref);
    expect(tabs).toEqual([first, second, third]);
  });

  it("moves right and keeps distinct tabs for the same session", () => {
    expect(reorderTabs(tabs, "one", "two", "after")).toEqual([second, first, third]);
    expect(reorderTabs(tabs, "one", "three", "after")).toEqual([second, third, first]);
  });

  it("does nothing for same place or missing tab IDs", () => {
    expect(reorderTabs(tabs, "one", "two", "before")).toBe(tabs);
    expect(reorderTabs(tabs, "two", "two", "after")).toBe(tabs);
    expect(reorderTabs(tabs, "missing", "one", "before")).toBe(tabs);
    expect(reorderTabs(tabs, "one", "missing", "after")).toBe(tabs);
  });
});
