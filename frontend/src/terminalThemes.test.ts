import { describe, expect, it } from "vitest";
import { normalizeTerminalTheme, resolveTerminalTheme, terminalThemes } from "./terminalThemes";

describe("terminal themes", () => {
  it("follows the application theme by default", () => {
    expect(normalizeTerminalTheme(undefined)).toBe("follow");
    expect(normalizeTerminalTheme("invalid")).toBe("follow");
    expect(resolveTerminalTheme("light", "follow")).toBe(terminalThemes.light);
    expect(resolveTerminalTheme("dark", undefined)).toBe(terminalThemes.dark);
  });

  it("supports independent global terminal schemes", () => {
    expect(resolveTerminalTheme("light", "classic")).toBe(terminalThemes.classic);
    expect(resolveTerminalTheme("dark", "light")).toBe(terminalThemes.light);
  });

  it("gives per-session palettes precedence and preserves other tabs", () => {
    expect(resolveTerminalTheme("dark", "classic", "light")).toBe(terminalThemes.light);
    expect(resolveTerminalTheme("dark", "classic", "follow")).toBe(terminalThemes.classic);
    expect(resolveTerminalTheme("light", "follow", "dark")).toBe(terminalThemes.dark);
  });

  it("provides all ANSI 16 colors for every palette", () => {
    const keys = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
      "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
      "brightMagenta", "brightCyan", "brightWhite"] as const;
    for (const theme of Object.values(terminalThemes)) {
      for (const key of keys) expect(theme[key]).toMatch(/^#[0-9A-F]{6}$/i);
      expect(theme.background).toMatch(/^#[0-9A-F]{6}$/i);
      expect(theme.foreground).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });
});

it("overview ruler edge matches terminal background in every theme", () => {
  for (const theme of Object.values(terminalThemes)) {
    expect(theme.overviewRulerBorder).toBe(theme.background);
  }
});

// Regression coverage for the three distinct, persisted theme IDs.
it("keeps readable contrast and the expected neutral backgrounds", () => {
  expect(terminalThemes.dark.background).toBe("#1E2228");
  expect(terminalThemes.classic.background).toBe("#0F1115");
  expect(terminalThemes.light.background).toBe("#F8FAFC");

  const luminance = (hex: string) => {
    const rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const linear = rgb.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  for (const palette of Object.values(terminalThemes)) {
    const foreground = luminance(palette.foreground!);
    const background = luminance(palette.background!);
    const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    expect(contrast).toBeGreaterThanOrEqual(7);
  }
});
