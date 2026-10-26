import { describe, expect, it } from "vitest";
import {
  MAX_SPLIT_PANES, addSplitPane, paneIDs, removePane, retainPanes,
  rotateActiveBranch, setSplitNodeRatio, splitGeometry, type SplitNode,
} from "./splitTree";

const add = (tree: SplitNode | null, source: string, target: string, side: "left" | "right" | "top" | "bottom") =>
  addSplitPane(tree, source, target, side, `split-${source}-${target}`);

describe("nested terminal split tree", () => {
  const double = () => add(null, "B", "A", "right")!;

  it("creates directional nested panes without replacing existing panes", () => {
    const three = add(double(), "C", "B", "bottom")!;
    const four = add(three, "D", "A", "left")!;
    expect(paneIDs(three)).toEqual(["A", "B", "C"]);
    expect(paneIDs(four)).toEqual(["D", "A", "B", "C"]);
    expect(four.type).toBe("split");
    expect(paneIDs(add(four, "E", "C", "right"))).toEqual(["D", "A", "B", "C"]);
    expect(paneIDs(four)).toHaveLength(MAX_SPLIT_PANES);
  });

  it("moves an already split pane without cloning its connection ID", () => {
    const three = add(double(), "C", "A", "top")!;
    const moved = add(three, "B", "C", "left")!;
    expect(paneIDs(moved).sort()).toEqual(["A", "B", "C"]);
    expect(new Set(paneIDs(moved)).size).toBe(3);
  });

  it("collapses vacant branches after undocking or closing panes", () => {
    const three = add(double(), "C", "B", "bottom")!;
    expect(paneIDs(removePane(three, "B"))).toEqual(["A", "C"]);
    expect(paneIDs(retainPanes(three, new Set(["A", "B"])))).toEqual(["A", "B"]);
    expect(paneIDs(removePane(removePane(three, "C"), "B"))).toEqual(["A"]);
  });

  it("resizes nested boundaries independently and keeps boxes inside the parent", () => {
    const tree = add(double(), "C", "B", "bottom")!;
    const nestedID = tree.type === "split" && tree.second.type === "split" ? tree.second.id : "";
    expect(nestedID).not.toBe("");
    const updated = setSplitNodeRatio(tree, nestedID, 70);
    const geometry = splitGeometry(updated, 1000, 700);
    expect(geometry.handles).toHaveLength(2);
    const right = geometry.handles.find(item => item.id === nestedID)!;
    const root = geometry.handles.find(item => item.id !== nestedID)!;
    expect(right.ratio).toBe(70);
    expect(root.ratio).toBe(50);
    expect(geometry.panes.A.left).toBe(0);
    expect(geometry.panes.B.top).toBeLessThan(geometry.panes.C.top);
    expect(geometry.panes.C.left).toBeGreaterThan(geometry.panes.A.left);
    expect(geometry.panes.C.top + geometry.panes.C.height).toBeCloseTo(700);
  });

  it("rotates only the active pane's nearest split", () => {
    const tree = add(double(), "C", "B", "bottom")!;
    const rotated = rotateActiveBranch(tree, "C");
    expect(rotated.type).toBe("split");
    if (rotated.type !== "split" || rotated.second.type !== "split") return;
    expect(rotated.direction).toBe("columns");
    expect(rotated.second.direction).toBe("columns");
    expect(paneIDs(rotated)).toEqual(["A", "B", "C"]);
  });

  it("rejects invalid self drops without mutating the original tree", () => {
    const tree = double();
    expect(add(tree, "A", "A", "left")).toBe(tree);
    expect(add(tree, "D", "missing", "right")).toBe(tree);
  });
});
