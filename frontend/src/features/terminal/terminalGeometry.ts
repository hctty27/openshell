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
