import { describe, expect, it } from "vitest";
import { getSplitDropIntent } from "./splitDrop";

describe("split drag and drop", () => {
  const bounds = { left: 100, top: 50, width: 800, height: 400 };

  it("selects the nearest edge of the target terminal", () => {
    expect(getSplitDropIntent(bounds, 110, 250))
      .toEqual({ zone: "left", mode: "edge" });
    expect(getSplitDropIntent(bounds, 890, 250))
      .toEqual({ zone: "right", mode: "edge" });
    expect(getSplitDropIntent(bounds, 500, 60))
      .toEqual({ zone: "top", mode: "edge" });
    expect(getSplitDropIntent(bounds, 500, 440))
      .toEqual({ zone: "bottom", mode: "edge" });
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
    expect(getSplitDropIntent(bounds, 505, 72, previous)).toEqual(previous);
  });

  it("falls back safely when terminal dimensions are invalid", () => {
    expect(getSplitDropIntent({ left: 0, top: 0, width: 0, height: 400 }, 10, 10))
      .toEqual({ zone: "right", mode: "smart" });
  });
});
