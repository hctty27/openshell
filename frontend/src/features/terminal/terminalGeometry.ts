export interface TerminalGeometry {
  cols: number;
  rows: number;
  left: number;
  top: number;
}

export interface TerminalGeometryInput {
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  scrollbarWidth: number;
  minimumGap?: number;
}

/**
 * Center the full terminal grid, not the last printed character.
 * The right edge of the usable area is the left edge of the native scrollbar.
 */
export function calculateTerminalGeometry({
  width,
  height,
  cellWidth,
  cellHeight,
  scrollbarWidth,
  minimumGap = 8,
}: TerminalGeometryInput): TerminalGeometry | null {
  if (![width, height, cellWidth, cellHeight, scrollbarWidth, minimumGap].every(Number.isFinite) ||
    width <= 0 || height <= 0 || cellWidth <= 0 || cellHeight <= 0) return null;

  const usableWidth = Math.max(0, width - scrollbarWidth);
  if (!usableWidth) return null;
  const gap = Math.max(0, minimumGap);
  const cols = Math.max(2, Math.floor((usableWidth - gap * 2) / cellWidth));
  const rows = Math.max(1, Math.floor((height - gap * 2) / cellHeight));

  return {
    cols,
    rows,
    left: Math.max(0, (usableWidth - cols * cellWidth) / 2),
    top: Math.max(0, (height - rows * cellHeight) / 2),
  };
}

export interface TerminalGridBounds {
  surfaceLeft: number;
  surfaceTop: number;
  surfaceBottom: number;
  gridLeft: number;
  gridRight: number;
  gridTop: number;
  gridBottom: number;
  scrollbarLeft: number;
}

/** Correct the CSS-grid rounding remainder using the actual scrollbar track edge. */
export function calculateGridCenteringCorrection(bounds: TerminalGridBounds): { x: number; y: number } | null {
  if (!Object.values(bounds).every(Number.isFinite) ||
      bounds.scrollbarLeft <= bounds.surfaceLeft ||
      bounds.gridRight <= bounds.gridLeft ||
      bounds.gridBottom <= bounds.gridTop) return null;

  const left = bounds.gridLeft - bounds.surfaceLeft;
  const right = bounds.scrollbarLeft - bounds.gridRight;
  const top = bounds.gridTop - bounds.surfaceTop;
  const bottom = bounds.surfaceBottom - bounds.gridBottom;
  if (Math.min(left, right, top, bottom) < -1) return null;
  return { x: (right - left) / 2, y: (bottom - top) / 2 };
}
