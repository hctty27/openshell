export const BASH_CWD_REPORT_COMMAND = "__openshell_report_cwd() { local path=\"${PWD//%/%25}\"; path=\"${path//#/%23}\"; path=\"${path//\\?/%3F}\"; printf '\\033]7;file://%s%s\\007' \"${HOSTNAME:-localhost}\" \"$path\"; }; if declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare -a'; then PROMPT_COMMAND+=(__openshell_report_cwd); else PROMPT_COMMAND=\"${PROMPT_COMMAND:+${PROMPT_COMMAND};}__openshell_report_cwd\"; fi; __openshell_report_cwd";

/**
 * Terminal-side cwd reports from OSC 7 and iTerm2 OSC 1337.
 * Only absolute POSIX paths are accepted; SFTP still validates existence.
 */
/** @internal Normalization helper shared by the OSC parsers and tests. */
export function normalizeRemoteDirectory(value: string): string | null {
  if (!value.startsWith("/") || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null;
  return value;
}

/** Safely change the working directory of a newly duplicated SSH shell. */
export function buildRemoteCdCommand(directory: string): string | null {
  const valid = normalizeRemoteDirectory(directory);
  if (!valid) return null;
  return `cd -- '${valid.replace(/'/g, "'\\''")}'\r`;
}

export type CloneDirectoryAction = "wait" | "skip" | "send";

/**
 * A new SSH PTY may start in an asset selector instead of a shell. Restore a
 * cloned directory only after recognizing a shell prompt, and avoid a no-op cd.
 */
export function decideCloneDirectoryAction(
  directory: string,
  home: string,
  promptLine: string,
  reportedDirectory?: string,
): CloneDirectoryAction {
  const target = normalizeRemoteDirectory(directory);
  if (!target) return "skip";

  const prompt = promptLine.trim();
  if (/^Opt>$/i.test(prompt)) return "skip";

  // Debian/Ubuntu: user@host:~$; RHEL/CentOS: [user@host ~]$.
  const match = /^(?:[\w.-]+@[\w.-]+:(.+)|\[[\w.-]+@[\w.-]+ (.+)\])([#$%])$/.exec(prompt);
  if (!match) return "wait";

  const shownDirectory = (match[1] ?? match[2]).trim();
  let current = normalizeRemoteDirectory(reportedDirectory ?? "");
  if (!current) {
    if (shownDirectory === "~") current = normalizeRemoteDirectory(home);
    else if (shownDirectory.startsWith("~/")) {
      current = normalizeRemoteDirectory(home.replace(/\/+$/, "") + shownDirectory.slice(1));
    } else current = normalizeRemoteDirectory(shownDirectory);
  }
  const comparable = (value: string) => value.replace(/\/+$/, "") || "/";
  return current && comparable(current) === comparable(target) ? "skip" : "send";
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

/**
 * Xshell-style terminal titles commonly use "user@host:/absolute/path" or
 * "user@host:~/relative/to/home". Ignore unrelated titles completely.
 * The SSH host's SFTP subsystem validates any resulting directory.
 */
export function parseOscTitleDirectory(title: string, home?: string): string | null {
  if (title.length > 4096 || /[\x00-\x1f\x7f]/.test(title)) return null;
  const match = /^.{1,256}:\s*(\/.*|~(?:\/.*)?)$/.exec(title);
  if (!match) return null;
  const path = match[1];
  if (!path.startsWith("~")) return normalizeRemoteDirectory(path);
  if (!home || !home.startsWith("/")) return null;
  if (path === "~") return normalizeRemoteDirectory(home);
  return normalizeRemoteDirectory(home.replace(/\/$/, "") + path.slice(1));
}
