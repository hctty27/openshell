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
