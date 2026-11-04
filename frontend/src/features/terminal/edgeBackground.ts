import type { IBufferCell, ITheme, Terminal } from "@xterm/xterm";

const ANSI_COLOR_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
  "brightMagenta", "brightCyan", "brightWhite",
] as const;

function paletteColor(index: number, theme: ITheme): string | null {
  if (index < 0 || index > 255) return null;
  if (index < 16) return theme[ANSI_COLOR_KEYS[index]] ?? null;
  if (index < 232) {
    const value = index - 16;
    const channels = [Math.floor(value / 36), Math.floor(value / 6) % 6, value % 6];
    return `#${channels.map(channel => (channel ? 55 + channel * 40 : 0).toString(16).padStart(2, "0")).join("")}`;
  }
  const gray = (8 + (index - 232) * 10).toString(16).padStart(2, "0");
  return `#${gray.repeat(3)}`;
}

function cellBackground(cell: IBufferCell, theme: ITheme): string | null {
  if (cell.isBgRGB()) return `#${cell.getBgColor().toString(16).padStart(6, "0")}`;
  if (cell.isBgPalette()) return paletteColor(cell.getBgColor(), theme);
  return null;
}

/** Fill unused pixel slivers only when a full-screen TUI paints every corner alike. */
export function getTerminalEdgeBackground(term: Terminal, theme: ITheme): string | null {
  const buffer = term.buffer.active;
  const top = buffer.viewportY;
  const first = buffer.getLine(top)?.getCell(0);
  if (!first || first.isBgDefault()) return null;

  const rows = [top, top + term.rows - 1];
  const columns = [0, term.cols - 1];
  for (const row of rows) {
    const line = buffer.getLine(row);
    for (const column of columns) {
      const cell = line?.getCell(column);
      if (!cell || cell.getBgColorMode() !== first.getBgColorMode() ||
          cell.getBgColor() !== first.getBgColor()) return null;
    }
  }
  return cellBackground(first, theme);
}
