# CSS structure and cascade order

OpenShell uses global CSS: terminal, Wails drag/drop, Fluent-style dialogs, and third-party xterm rules all depend on class selectors. Keep **`src/styles.css`** as the single entrypoint imported by `src/main.tsx`.

The entrypoint imports these files in original source order:

| File | Responsibility |
| --- | --- |
| `00-foundation.css` | Theme tokens, application defaults, native form controls |
| `01-sessions.css` | Left session sidebar, session rows and connection indicators |
| `02-workspace-terminal.css` | Workspace chrome, tabs, split panes, terminal and transfer dock |
| `04-dialog-foundations.css` | Legacy dialog primitives, notifications and responsive foundations |
| `05-session-tree-commands.css` | Tree layout, session properties and quick-command surfaces |
| `06-dialogs-pickers.css` | Shared dialogs, session picker, floating menus and session editor |
| `07-settings.css` | Workspace settings navigation and controls |
| `08-sftp-browser.css` | SFTP browser and Xshell import |
| `09-sftp-zmodem-transfers.css` | SFTP editor and embedded ZMODEM transfer dialogs |
| `10-dialog-overlays.css` | Shared modal surfaces and responsive dialogs |

## Rules for future changes

- Maintain import order in `src/styles.css`. The ordering preserves intentional overrides and media rules from the previous single-file stylesheet.
- The initial extraction was verified by concatenating all 10 files and comparing the result byte-for-byte with the original original stylesheet.
- Add related selectors to the matching file; consider the existing cascade when modifying rules and do not create arbitrary `@layer` declarations.
- Keep Wails and xterm runtime class selectors even when static code search cannot find an explicit JSX reference.
- The CI-enforced `npm run audit:styles` script checks that the module manifest stays in its reviewed order and no module is missing or empty.
- For changes affecting styling, run the frontend build, `npm run audit:styles`, Vitest, and the Playwright workspace checks before merging.
