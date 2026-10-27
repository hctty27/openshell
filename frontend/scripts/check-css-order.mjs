import { readFileSync } from "node:fs";

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

const entry = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const expected = orderedModules
  .map((name) => `@import "./styles/${name}.css";`)
  .join("\n") + "\n";

if (entry !== expected) {
  throw new Error("CSS imports changed: update the reviewed cascade order intentionally.");
}

for (const name of orderedModules) {
  const css = readFileSync(new URL(`../src/styles/${name}.css`, import.meta.url), "utf8");
  if (!css.trim()) {
    throw new Error(`CSS module is empty: ${name}`);
  }
}

process.stdout.write(`Verified ${orderedModules.length} ordered CSS modules.\n`);
