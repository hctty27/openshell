import { describe, expect, it } from "vitest";
import { getSplitDropZone, splitLayoutFromDrop } from "./splitDrop";

describe("split drag and drop", () => {
  const bounds = { left: 100, top: 50, width: 800, height: 400 };

  it("selects the nearest edge of the target terminal", () => {
    expect(getSplitDropZone(bounds, 110, 250)).toBe("left");
    expect(getSplitDropZone(bounds, 890, 250)).toBe("right");
    expect(getSplitDropZone(bounds, 500, 60)).toBe("top");
    expect(getSplitDropZone(bounds, 500, 440)).toBe("bottom");
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
