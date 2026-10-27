# CSS structure and cascade order

OpenShell uses global CSS: terminal, Wails drag/drop, Fluent-style dialogs, and third-party xterm rules all depend on class selectors. Keep **`src/styles.css`** as the single entrypoint imported by `src/main.tsx`.

The entrypoint imports these files in original source order:

| File | Responsibility |
| --- | --- |
| `00-foundation.css` | Theme tokens, application defaults, native form controls |
| `01-sessions.css` | Left session sidebar, session rows and connection indicators |
| `02-workspace-terminal.css` | Workspace chrome, tabs, split panes, terminal and transfer dock |
| `03-ai-sidebar.css` | AI sidebar, chat messages, composer and proposals |
| `04-dialog-foundations.css` | Legacy dialog primitives, notifications and responsive foundations |
| `05-session-tree-commands.css` | Tree layout, session properties and quick-command surfaces |
| `06-dialogs-pickers.css` | Shared dialogs, session picker, floating menus and session editor |
| `07-settings.css` | Workspace settings navigation and controls |
| `08-sftp-browser.css` | SFTP browser and Xshell import |
| `09-conversation-transfers.css` | AI conversation switcher, SFTP editor and ZMODEM interfaces |
| `10-overlays-ai-ops.css` | Modal surfaces, AI target scope and operation status |

## Rules for future changes

- Maintain import order in `src/styles.css`. The ordering preserves intentional overrides and media rules from the previous single-file stylesheet.
- The initial extraction was verified by concatenating all 11 files and comparing the result byte-for-byte with the original 90,397-character stylesheet.
- Add related selectors to the matching file; consider the existing cascade when modifying rules and do not create arbitrary `@layer` declarations.
- Keep Wails and xterm runtime class selectors even when static code search cannot find an explicit JSX reference.
- For changes affecting styling, run the frontend build, Vitest, and the Playwright workspace checks before merging.
