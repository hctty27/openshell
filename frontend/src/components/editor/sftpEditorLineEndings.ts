export type LineEnding = "\n" | "\r\n" | "\r";

/** Preserve the file's original line-ending convention when saving. */
export function detectLineEnding(content: string): LineEnding {
  const first = /\r\n|\r|\n/.exec(content)?.[0];
  return first === "\r\n" || first === "\r" ? first : "\n";
}

/** CodeMirror uses LF internally; never let pasted CR characters become document text. */
export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n|\r/g, "\n");
}

/** Convert CodeMirror's normalized text back to the file's original line endings. */
export function serializeLineEndings(content: string, lineEnding: LineEnding): string {
  const normalized = normalizeLineEndings(content);
  return lineEnding === "\n" ? normalized : normalized.replace(/\n/g, lineEnding);
}
