import { describe, expect, it } from "vitest";
import { getSplitDropZone, getSplitDropIntent, splitLayoutFromDrop } from "./splitDrop";

describe("split drag and drop", () => {
  const bounds = { left: 100, top: 50, width: 800, height: 400 };

  it("selects the nearest edge of the target terminal", () => {
    expect(getSplitDropZone(bounds, 110, 250)).toBe("left");
    expect(getSplitDropZone(bounds, 890, 250)).toBe("right");
    expect(getSplitDropZone(bounds, 500, 60)).toBe("top");
    expect(getSplitDropZone(bounds, 500, 440)).toBe("bottom");
  });

  it("selects a forgiving smart center based on terminal aspect ratio", () => {
    expect(getSplitDropIntent(bounds, 500, 250))
      .toEqual({ zone: "right", mode: "smart" });
    expect(getSplitDropIntent({ left: 0, top: 0, width: 240, height: 700 }, 120, 350))
      .toEqual({ zone: "bottom", mode: "smart" });
  });

  it("applies edge hysteresis to prevent flickering near adjacent regions", () => {
    const previous = getSplitDropIntent(bounds, 500, 65);
    expect(previous).toEqual({ zone: "top", mode: "edge" });
    expect(getSplitDropIntent(bounds, 125, 88, previous)).toEqual(previous);
  });

  it("produces ordered horizontal and vertical layouts", () => {
    expect(splitLayoutFromDrop("B", "A", "left")).toEqual({
      pair: ["B", "A"], direction: "columns",
    });
    expect(splitLayoutFromDrop("B", "A", "right")).toEqual({
      pair: ["A", "B"], direction: "columns",
    });
    expect(splitLayoutFromDrop("B", "A", "top")).toEqual({
      pair: ["B", "A"], direction: "rows",
    });
    expect(splitLayoutFromDrop("B", "A", "bottom")).toEqual({
      pair: ["A", "B"], direction: "rows",
    });
  });

  it("rejects dropping a tab onto itself", () => {
    expect(splitLayoutFromDrop("A", "A", "right")).toBeNull();
  });
});
