import { describe, expect, it } from "vitest";
import { calculateTerminalGeometry, calculateGridCenteringCorrection } from "./terminalGeometry";

describe("calculateTerminalGeometry", () => {
  it("centers the grid between the left edge and the scrollbar's left edge", () => {
    const size = { width: 1000, height: 600, scrollbarWidth: 8, cellWidth: 9, cellHeight: 18 };
    const result = calculateTerminalGeometry(size)!;
    const right = size.width - size.scrollbarWidth - result.left - result.cols * size.cellWidth;
    const bottom = size.height - result.top - result.rows * size.cellHeight;
    expect(result.left).toBeGreaterThanOrEqual(8);
    expect(result.top).toBeGreaterThanOrEqual(8);
    expect(Math.abs(result.left - right)).toBeLessThan(1e-6);
    expect(Math.abs(result.top - bottom)).toBeLessThan(1e-6);
    expect(result.cols).toBe(108);
    expect(result.rows).toBe(32);
  });

  it("remains centered across resized, fractional, and high-DPI cell dimensions", () => {
    for (const width of [280, 340, 640, 841, 1040, 1441]) {
      for (const height of [205, 332, 503, 700]) {
        for (const cellWidth of [7.75, 8.4, 9.16]) {
          const cellHeight = 16.7;
          const result = calculateTerminalGeometry({ width, height, scrollbarWidth: 8, cellWidth, cellHeight })!;
          const right = width - 8 - result.left - result.cols * cellWidth;
          const bottom = height - result.top - result.rows * cellHeight;
          expect(Math.abs(result.left - right)).toBeLessThan(1e-6);
          expect(Math.abs(result.top - bottom)).toBeLessThan(1e-6);
          expect(result.left).toBeGreaterThanOrEqual(8 - 1e-6);
          expect(result.top).toBeGreaterThanOrEqual(8 - 1e-6);
          expect(result.cols * cellWidth + result.left).toBeLessThanOrEqual(width - 8);
          expect(result.rows * cellHeight + result.top).toBeLessThanOrEqual(height);
        }
      }
    }
  });

  it("does not compute a geometry for a hidden or unmeasured terminal", () => {
    expect(calculateTerminalGeometry({ width: 0, height: 500, scrollbarWidth: 8, cellWidth: 8, cellHeight: 16 })).toBeNull();
    expect(calculateTerminalGeometry({ width: 700, height: 500, scrollbarWidth: 8, cellWidth: 0, cellHeight: 16 })).toBeNull();
    expect(calculateTerminalGeometry({ width: NaN, height: 500, scrollbarWidth: 8, cellWidth: 8, cellHeight: 16 })).toBeNull();
  });

  it("keeps minimum rows and columns for a temporarily narrow split", () => {
    const result = calculateTerminalGeometry({
      width: 22, height: 20, scrollbarWidth: 8, cellWidth: 8, cellHeight: 16,
    })!;
    expect(result.cols).toBe(2);
    expect(result.rows).toBe(1);
    expect(result.left).toBe(0);
    expect(result.top).toBe(2);
  });
});

describe("calculateGridCenteringCorrection", () => {
  it("balances horizontal spacing to the real scrollbar track, not the thumb or outer edge", () => {
    const delta = calculateGridCenteringCorrection({
      surfaceLeft: 0, surfaceTop: 0, surfaceBottom: 600,
      gridLeft: 9, gridRight: 988, gridTop: 10, gridBottom: 586,
      scrollbarLeft: 1000,
    });
    expect(delta).toEqual({ x: 1.5, y: 2 });
  });

  it("does not modify an already centered grid", () => {
    expect(calculateGridCenteringCorrection({
      surfaceLeft: 10, surfaceTop: 20, surfaceBottom: 620,
      gridLeft: 20, gridRight: 990, gridTop: 32, gridBottom: 608,
      scrollbarLeft: 1000,
    })).toEqual({ x: 0, y: 0 });
  });

  it("rejects transient invalid/oversized screen geometry", () => {
    expect(calculateGridCenteringCorrection({
      surfaceLeft: 0, surfaceTop: 0, surfaceBottom: 600,
      gridLeft: 8, gridRight: 1100, gridTop: 8, gridBottom: 580,
      scrollbarLeft: 1000,
    })).toBeNull();
    expect(calculateGridCenteringCorrection({
      surfaceLeft: 0, surfaceTop: 0, surfaceBottom: 600,
      gridLeft: 8, gridRight: 980, gridTop: 8, gridBottom: 580,
      scrollbarLeft: Number.NaN,
    })).toBeNull();
  });
});
