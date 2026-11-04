export type IndentMode = "auto" | "spaces" | "tabs";
export type IndentSize = 2 | 4 | 8;

export interface SFTPEditorPreferences {
  indentMode: IndentMode;
  indentSize: IndentSize;
  lineNumbers: boolean;
  syntaxHighlight: boolean;
  wordWrap: boolean;
}

const STORAGE_KEY = "openshell.sftp.editor.preferences";
export const DEFAULT_SFTP_EDITOR_PREFERENCES: SFTPEditorPreferences = {
  indentMode: "auto",
  indentSize: 4,
  lineNumbers: true,
  syntaxHighlight: true,
  wordWrap: false,
};

export function readSFTPEditorPreferences(): SFTPEditorPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SFTP_EDITOR_PREFERENCES };
    const data = JSON.parse(raw) as Partial<SFTPEditorPreferences>;
    return {
      indentMode: data.indentMode === "spaces" || data.indentMode === "tabs" ? data.indentMode : "auto",
      indentSize: data.indentSize === 2 || data.indentSize === 8 ? data.indentSize : 4,
      lineNumbers: typeof data.lineNumbers === "boolean" ? data.lineNumbers : true,
      syntaxHighlight: typeof data.syntaxHighlight === "boolean" ? data.syntaxHighlight : true,
      wordWrap: typeof data.wordWrap === "boolean" ? data.wordWrap : false,
    };
  } catch {
    return { ...DEFAULT_SFTP_EDITOR_PREFERENCES };
  }
}

export function writeSFTPEditorPreferences(preferences: SFTPEditorPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // The editor still works when storage is unavailable.
  }
}

export function detectIndentation(content: string, fallback: IndentSize): { mode: "spaces" | "tabs"; size: IndentSize } {
  const lines = content.split(/\r?\n/).filter(line => /\S/.test(line)).slice(0, 200);
  let tabLines = 0;
  const spaces: number[] = [];
  for (const line of lines) {
    const leading = /^([ \t]+)/.exec(line)?.[1];
    if (!leading) continue;
    if (leading[0] === "\t") tabLines++;
    else if (!leading.includes("\t")) spaces.push(leading.length);
  }
  if (tabLines > spaces.length) return { mode: "tabs", size: fallback };
  if (spaces.length === 0) return { mode: "spaces", size: fallback };
  const divisors: IndentSize[] = [2, 4, 8];
  const scores = divisors.map(size => ({
    size,
    count: spaces.filter(n => n % size === 0).length,
  }));
  scores.sort((a, b) => b.count - a.count || (a.size === fallback ? -1 : b.size === fallback ? 1 : a.size - b.size));
  return { mode: "spaces", size: scores[0].size };
}
