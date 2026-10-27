import { describe, expect, it } from "vitest";
import entrypoint from "./styles.css?raw";
import sheet0 from "./styles/00-foundation.css?raw";
import sheet1 from "./styles/01-sessions.css?raw";
import sheet2 from "./styles/02-workspace-terminal.css?raw";
import sheet3 from "./styles/03-ai-sidebar.css?raw";
import sheet4 from "./styles/04-dialog-foundations.css?raw";
import sheet5 from "./styles/05-session-tree-commands.css?raw";
import sheet6 from "./styles/06-dialogs-pickers.css?raw";
import sheet7 from "./styles/07-settings.css?raw";
import sheet8 from "./styles/08-sftp-browser.css?raw";
import sheet9 from "./styles/09-conversation-transfers.css?raw";
import sheet10 from "./styles/10-overlays-ai-ops.css?raw";

const orderedModules = [
  { name: "00-foundation", content: sheet0 },
  { name: "01-sessions", content: sheet1 },
  { name: "02-workspace-terminal", content: sheet2 },
  { name: "03-ai-sidebar", content: sheet3 },
  { name: "04-dialog-foundations", content: sheet4 },
  { name: "05-session-tree-commands", content: sheet5 },
  { name: "06-dialogs-pickers", content: sheet6 },
  { name: "07-settings", content: sheet7 },
  { name: "08-sftp-browser", content: sheet8 },
  { name: "09-conversation-transfers", content: sheet9 },
  { name: "10-overlays-ai-ops", content: sheet10 },
];

describe("global stylesheet entrypoint", () => {
  it("preserves the explicit CSS cascade order", () => {
    const expected = orderedModules
      .map(({ name }) => `@import "./styles/${name}.css";`)
      .join("\n") + "\n";

    expect(entrypoint).toBe(expected);
  });

  it("keeps every CSS module available and non-empty", () => {
    for (const { name, content } of orderedModules) {
      expect(content.trim().length, name).toBeGreaterThan(0);
    }
  });
});
