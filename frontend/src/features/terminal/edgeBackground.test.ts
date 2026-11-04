import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { terminalThemes } from "../../terminalThemes";
import { getTerminalEdgeBackground } from "./edgeBackground";

type Color = { mode: "default" | "palette" | "rgb"; value: number };

function mockTerm(corners: [Color, Color, Color, Color]): Terminal {
  const cells = corners.map(({ mode, value }) => ({
    isBgDefault: () => mode === "default",
    isBgRGB: () => mode === "rgb",
    isBgPalette: () => mode === "palette",
    getBgColorMode: () => mode,
    getBgColor: () => value,
  }));
  return {
    cols: 80,
    rows: 24,
    buffer: {
      active: {
        viewportY: 4,
        getLine: (row: number) => ({
          getCell: (col: number) => cells[(row === 4 ? 0 : 2) + (col === 0 ? 0 : 1)],
        }),
      },
    },
  } as unknown as Terminal;
}

const palette = (value: number): Color => ({ mode: "palette", value });
const rgb = (value: number): Color => ({ mode: "rgb", value });
const defaults = (): Color => ({ mode: "default", value: 0 });

describe("terminal edge background", () => {
  it("extends a full-screen dialog's ANSI background into unused pixels", () => {
    const term = mockTerm([palette(4), palette(4), palette(4), palette(4)]);
    expect(getTerminalEdgeBackground(term, terminalThemes.classic)).toBe(terminalThemes.classic.blue);
  });

  it("supports 256-color and true-color full-screen backgrounds", () => {
    expect(getTerminalEdgeBackground(mockTerm([palette(21), palette(21), palette(21), palette(21)]), terminalThemes.dark)).toBe("#0000ff");
    expect(getTerminalEdgeBackground(mockTerm([palette(232), palette(232), palette(232), palette(232)]), terminalThemes.dark)).toBe("#080808");
    expect(getTerminalEdgeBackground(mockTerm([rgb(0xabcdef), rgb(0xabcdef), rgb(0xabcdef), rgb(0xabcdef)]), terminalThemes.dark)).toBe("#abcdef");
  });

  it("does not tint unused pixels for normal shell or mixed-color TUI edges", () => {
    expect(getTerminalEdgeBackground(mockTerm([defaults(), defaults(), defaults(), defaults()]), terminalThemes.dark)).toBeNull();
    expect(getTerminalEdgeBackground(mockTerm([palette(4), palette(4), palette(4), palette(1)]), terminalThemes.dark)).toBeNull();
  });
});
