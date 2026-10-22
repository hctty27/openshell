import type { ITheme } from "@xterm/xterm";
import type { TerminalTheme, Theme } from "./types";

export const terminalThemes: Record<Exclude<TerminalTheme, "follow">, ITheme> = {
  dark: {
    background: "#171A1F",
    overviewRulerBorder: "#171A1F",
    foreground: "#DCE4EE",
    cursor: "#96BDF0",
    cursorAccent: "#171A1F",
    selectionBackground: "#41668D99",
    selectionInactiveBackground: "#41668D66",
    black: "#343A44",
    red: "#E67B83",
    green: "#7FD7A0",
    yellow: "#E4C47B",
    blue: "#84ACDB",
    magenta: "#C39BE2",
    cyan: "#72CCD5",
    white: "#CBD4E1",
    brightBlack: "#8A97A9",
    brightRed: "#FC9399",
    brightGreen: "#99E8B3",
    brightYellow: "#F4D995",
    brightBlue: "#A5C8F4",
    brightMagenta: "#D8B5F2",
    brightCyan: "#91E6EA",
    brightWhite: "#F2F5FA",
    scrollbarSliderBackground: "#7A879950",
    scrollbarSliderHoverBackground: "#7A879999",
    scrollbarSliderActiveBackground: "#7A8799CC",
  },
  classic: {
    background: "#08090C",
    overviewRulerBorder: "#08090C",
    foreground: "#E0E4EA",
    cursor: "#EDF2FA",
    cursorAccent: "#08090C",
    selectionBackground: "#416AAB99",
    selectionInactiveBackground: "#416AAB66",
    black: "#242933",
    red: "#E57980",
    green: "#79D395",
    yellow: "#E0BE71",
    blue: "#79A9E5",
    magenta: "#BB98DE",
    cyan: "#6EC7D3",
    white: "#CCD3DF",
    brightBlack: "#7E899A",
    brightRed: "#FF939A",
    brightGreen: "#A0E6B3",
    brightYellow: "#F6D999",
    brightBlue: "#A7CAFF",
    brightMagenta: "#D8B1F7",
    brightCyan: "#99E5E9",
    brightWhite: "#FFFFFF",
    scrollbarSliderBackground: "#8691A450",
    scrollbarSliderHoverBackground: "#8691A499",
    scrollbarSliderActiveBackground: "#8691A4CC",
  },
  light: {
    background: "#FFFFFF",
    overviewRulerBorder: "#FFFFFF",
    foreground: "#263445",
    cursor: "#2766AD",
    cursorAccent: "#FFFFFF",
    selectionBackground: "#A9C7EDAA",
    selectionInactiveBackground: "#A9C7ED66",
    black: "#2D3745",
    red: "#B52D41",
    green: "#21754D",
    yellow: "#865C0B",
    blue: "#2766AD",
    magenta: "#8343A5",
    cyan: "#136D7C",
    white: "#6D7786",
    brightBlack: "#5B6573",
    brightRed: "#B82037",
    brightGreen: "#116C44",
    brightYellow: "#765106",
    brightBlue: "#1B569D",
    brightMagenta: "#742D98",
    brightCyan: "#075F71",
    brightWhite: "#344153",
    scrollbarSliderBackground: "#52647E50",
    scrollbarSliderHoverBackground: "#52647E99",
    scrollbarSliderActiveBackground: "#52647ECC",
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
