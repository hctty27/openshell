import type { ITheme } from "@xterm/xterm";
import type { TerminalTheme, Theme } from "./types";

/** @internal Theme palette fixture exposed to unit tests. */
export const terminalThemes: Record<Exclude<TerminalTheme, "follow">, ITheme> = {
  dark: {
    background: "#1E2228",
    overviewRulerBorder: "#1E2228",
    foreground: "#DCE1E8",
    cursor: "#82B1FF",
    cursorAccent: "#1E2228",
    selectionBackground: "#4B86C680",
    selectionInactiveBackground: "#4B86C64D",
    black: "#667384",
    red: "#E57373",
    green: "#81C995",
    yellow: "#E6BF74",
    blue: "#82B1FF",
    magenta: "#B89CF1",
    cyan: "#74C5D4",
    white: "#CED5DE",
    brightBlack: "#94A1AF",
    brightRed: "#F29393",
    brightGreen: "#A2DFB2",
    brightYellow: "#F4D590",
    brightBlue: "#A4C8FF",
    brightMagenta: "#D2B5FF",
    brightCyan: "#95DEE9",
    brightWhite: "#F6F8FB",
    scrollbarSliderBackground: "#8794A646",
    scrollbarSliderHoverBackground: "#8794A68A",
    scrollbarSliderActiveBackground: "#A4AFBDAD",
  },
  classic: {
    background: "#0F1115",
    overviewRulerBorder: "#0F1115",
    foreground: "#E5E9F0",
    cursor: "#AACDFF",
    cursorAccent: "#0F1115",
    selectionBackground: "#527BB18C",
    selectionInactiveBackground: "#527BB14D",
    black: "#697588",
    red: "#E87A7A",
    green: "#80CFA0",
    yellow: "#E6C47A",
    blue: "#85B5F1",
    magenta: "#C09EE5",
    cyan: "#77CED3",
    white: "#D2DAE5",
    brightBlack: "#99A6B8",
    brightRed: "#FF9B9B",
    brightGreen: "#ABEDC2",
    brightYellow: "#F9DFA0",
    brightBlue: "#AACDFF",
    brightMagenta: "#D9BCF6",
    brightCyan: "#9EE7EF",
    brightWhite: "#FFFFFF",
    scrollbarSliderBackground: "#8D9AAB46",
    scrollbarSliderHoverBackground: "#8D9AAB8A",
    scrollbarSliderActiveBackground: "#AEBBD0AD",
  },
  light: {
    background: "#F8FAFC",
    overviewRulerBorder: "#F8FAFC",
    foreground: "#263445",
    cursor: "#2766AD",
    cursorAccent: "#F8FAFC",
    selectionBackground: "#8BB5E580",
    selectionInactiveBackground: "#8BB5E54D",
    black: "#344153",
    red: "#BA364A",
    green: "#21754D",
    yellow: "#946514",
    blue: "#2766AD",
    magenta: "#8343A5",
    cyan: "#136D7C",
    white: "#647184",
    brightBlack: "#566477",
    brightRed: "#A82A40",
    brightGreen: "#14643F",
    brightYellow: "#82560A",
    brightBlue: "#1C5699",
    brightMagenta: "#742D98",
    brightCyan: "#075F71",
    brightWhite: "#324051",
    scrollbarSliderBackground: "#71819746",
    scrollbarSliderHoverBackground: "#7181978C",
    scrollbarSliderActiveBackground: "#53647BB0",
  },
};

export function normalizeTerminalTheme(value: unknown): TerminalTheme {
  return value === "classic" || value === "dark" || value === "light" ? value : "follow";
}

export function resolveTerminalTheme(
  appTheme: Theme,
  globalTerminalTheme: TerminalTheme | undefined,
  sessionTerminalTheme?: TerminalTheme,
): ITheme {
  const override = normalizeTerminalTheme(sessionTerminalTheme);
  const selected = override === "follow"
    ? normalizeTerminalTheme(globalTerminalTheme)
    : override;
  return terminalThemes[selected === "follow" ? appTheme : selected];
}
