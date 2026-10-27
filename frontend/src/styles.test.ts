import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const orderedModules = [
  "00-foundation",
  "01-sessions",
  "02-workspace-terminal",
  "03-ai-sidebar",
  "04-dialog-foundations",
  "05-session-tree-commands",
  "06-dialogs-pickers",
  "07-settings",
  "08-sftp-browser",
  "09-conversation-transfers",
  "10-overlays-ai-ops",
];

describe("global stylesheet entrypoint", () => {
  it("preserves the explicit CSS cascade order", () => {
    const index = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const expected = orderedModules
      .map((name) => `@import "./styles/${name}.css";`)
      .join("\n") + "\n";

    expect(index).toBe(expected);
  });

  it("keeps every imported CSS module available", () => {
    for (const name of orderedModules) {
      const styles = readFileSync(new URL(`./styles/${name}.css`, import.meta.url), "utf8");
      expect(styles.trim().length, name).toBeGreaterThan(0);
    }
  });
});
