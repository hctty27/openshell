export const BASH_CWD_REPORT_COMMAND = String.raw`__openshell_report_cwd() { printf '\033]7;file://%s%s\007' "${HOSTNAME:-localhost}" "$PWD"; }; if declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare -a'; then PROMPT_COMMAND+=(__openshell_report_cwd); else PROMPT_COMMAND="${PROMPT_COMMAND:+${PROMPT_COMMAND};}__openshell_report_cwd"; fi; __openshell_report_cwd`;

/**
 * Terminal-side cwd reports from OSC 7 and iTerm2 OSC 1337.
 * Only absolute POSIX paths are accepted; SFTP still validates existence.
 */
export function normalizeRemoteDirectory(value: string): string | null {
  if (!value.startsWith("/") || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null;
  return value;
}

export function parseOsc7Directory(payload: string): string | null {
  try {
    const url = new URL(payload);
    if (url.protocol !== "file:" || url.username || url.password || url.search || url.hash) return null;
    return normalizeRemoteDirectory(decodeURIComponent(url.pathname));
  } catch {
    return null;
  }
}

export function parseOsc1337Directory(payload: string): string | null {
  if (!payload.startsWith("CurrentDir=")) return null;
  const raw = payload.slice("CurrentDir=".length);
  try {
    return normalizeRemoteDirectory(decodeURIComponent(raw));
  } catch {
    return null;
  }
}
