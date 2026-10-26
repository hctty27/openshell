import type { SplitDropZone, SplitDirection } from "./splitDrop";

export type SplitNode =
  | { type: "pane"; tabID: string }
  | { type: "split"; id: string; direction: SplitDirection; ratio: number; first: SplitNode; second: SplitNode };

export interface SplitBox { left: number; top: number; width: number; height: number }
export interface SplitHandle extends SplitBox {
  id: string;
  direction: SplitDirection;
  ratio: number;
  parent: SplitBox;
}
export interface SplitGeometry {
  panes: Record<string, SplitBox>;
  handles: SplitHandle[];
}

export const MAX_SPLIT_PANES = 4;
export const SPLIT_GUTTER = 6;
export const pane = (tabID: string): SplitNode => ({ type: "pane", tabID });
export const clampRatio = (ratio: number): number => Math.round(Math.max(20, Math.min(80, ratio)));

export function paneIDs(node: SplitNode | null): string[] {
  if (!node) return [];
  return node.type === "pane" ? [node.tabID] : [...paneIDs(node.first), ...paneIDs(node.second)];
}

export function removePane(node: SplitNode | null, tabID: string): SplitNode | null {
  if (!node) return null;
  if (node.type === "pane") return node.tabID === tabID ? null : node;
  const first = removePane(node.first, tabID);
  const second = removePane(node.second, tabID);
  if (!first) return second;
  if (!second) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

function replacePane(node: SplitNode, tabID: string, replacement: SplitNode): SplitNode {
  if (node.type === "pane") return node.tabID === tabID ? replacement : node;
  const first = replacePane(node.first, tabID, replacement);
  const second = replacePane(node.second, tabID, replacement);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function addSplitPane(
  layout: SplitNode | null, sourceID: string, targetID: string,
  zone: SplitDropZone, branchID: string, preferredRatio = 50,
): SplitNode | null {
  if (!sourceID || !targetID || sourceID === targetID || !branchID) return layout;
  const original = layout ?? pane(targetID);
  const existing = paneIDs(original);
  if (!existing.includes(targetID)) return layout;
  if (!existing.includes(sourceID) && existing.length >= MAX_SPLIT_PANES) return layout;
  const withoutSource = removePane(original, sourceID);
  if (!withoutSource || !paneIDs(withoutSource).includes(targetID)) return layout;
  const sourceFirst = zone === "left" || zone === "top";
  const direction: SplitDirection = zone === "left" || zone === "right" ? "columns" : "rows";
  const newBranch: SplitNode = {
    type: "split", id: branchID, direction, ratio: clampRatio(preferredRatio),
    first: sourceFirst ? pane(sourceID) : pane(targetID),
    second: sourceFirst ? pane(targetID) : pane(sourceID),
  };
  return replacePane(withoutSource, targetID, newBranch);
}

export function setSplitNodeRatio(node: SplitNode, id: string, ratio: number): SplitNode {
  if (node.type === "pane") return node;
  if (node.id === id) return { ...node, ratio: clampRatio(ratio) };
  const first = setSplitNodeRatio(node.first, id, ratio);
  const second = setSplitNodeRatio(node.second, id, ratio);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function rotateActiveBranch(node: SplitNode, activeID: string): SplitNode {
  if (node.type === "pane" || !paneIDs(node).includes(activeID)) return node;
  const first = paneIDs(node.first).includes(activeID);
  const child = first ? node.first : node.second;
  if (child.type === "split") {
    const rotated = rotateActiveBranch(child, activeID);
    return { ...node, [first ? "first" : "second"]: rotated };
  }
  return { ...node, direction: node.direction === "columns" ? "rows" : "columns" };
}

export function retainPanes(node: SplitNode | null, valid: ReadonlySet<string>): SplitNode | null {
  if (!node) return null;
  if (node.type === "pane") return valid.has(node.tabID) ? node : null;
  const first = retainPanes(node.first, valid);
  const second = retainPanes(node.second, valid);
  if (!first) return second;
  if (!second) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function splitGeometry(layout: SplitNode | null, width: number, height: number): SplitGeometry {
  const panes: Record<string, SplitBox> = {};
  const handles: SplitHandle[] = [];
  if (!layout) return { panes, handles };
  const visit = (node: SplitNode, box: SplitBox) => {
    if (node.type === "pane") {
      panes[node.tabID] = box;
      return;
    }
    const horizontal = node.direction === "columns";
    const length = Math.max(0, (horizontal ? box.width : box.height) - SPLIT_GUTTER);
    const firstSize = length * clampRatio(node.ratio) / 100;
    const secondSize = length - firstSize;
    if (horizontal) {
      visit(node.first, { ...box, width: firstSize });
      visit(node.second, { left: box.left + firstSize + SPLIT_GUTTER, top: box.top, width: secondSize, height: box.height });
      handles.push({ id: node.id, direction: node.direction, ratio: node.ratio, parent: box,
        left: box.left + firstSize, top: box.top, width: SPLIT_GUTTER, height: box.height });
    } else {
      visit(node.first, { ...box, height: firstSize });
      visit(node.second, { left: box.left, top: box.top + firstSize + SPLIT_GUTTER, width: box.width, height: secondSize });
      handles.push({ id: node.id, direction: node.direction, ratio: node.ratio, parent: box,
        left: box.left, top: box.top + firstSize, width: box.width, height: SPLIT_GUTTER });
    }
  };
  visit(layout, { left: 0, top: 0, width: Math.max(0, width), height: Math.max(0, height) });
  return { panes, handles };
}
