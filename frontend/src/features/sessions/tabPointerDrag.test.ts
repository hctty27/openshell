import { describe, expect, it } from "vitest";
import { tabInsertionIndex, reorderFromInsertion, tabEdgeScrollSpeed } from "./tabPointerDrag";

describe("pointer-based tab sorting", () => {
  const tabs = [
    { id: "A", left: 0, width: 100 },
    { id: "B", left: 100, width: 140 },
    { id: "C", left: 240, width: 120 },
    { id: "D", left: 360, width: 110 },
  ];

  it("calculates insertion by the other tabs' centers", () => {
    expect(tabInsertionIndex(tabs, "B", 30)).toBe(0);
    expect(tabInsertionIndex(tabs, "B", 290)).toBe(2);
    expect(tabInsertionIndex(tabs, "B", 480)).toBe(3);
    expect(reorderFromInsertion(["A", "B", "C", "D"], "B", 3))
      .toEqual({ targetID: "D", placement: "after" });
  });

  it("does not emit invalid operations", () => {
    expect(reorderFromInsertion(["A"], "A", 0)).toBeNull();
    expect(reorderFromInsertion(["A", "B"], "unknown", 0)).toBeNull();
  });

  it("scrolls continuously towards either edge without leaving the strip", () => {
    expect(tabEdgeScrollSpeed(101, 100, 600)).toBeLessThan(0);
    expect(tabEdgeScrollSpeed(599, 100, 600)).toBeGreaterThan(0);
    expect(tabEdgeScrollSpeed(350, 100, 600)).toBe(0);
    expect(tabEdgeScrollSpeed(99, 100, 600)).toBe(0);
  });
});
