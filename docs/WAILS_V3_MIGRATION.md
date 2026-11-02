# OpenShell Wails v3 migration

## Scope

The Windows shell has been ported from Wails v2 to **Wails v3.0.0**.
SSH, SFTP, ZMODEM and data storage remain in their existing Go modules.

- `main.go`: app/service lifecycle, native dialogs, file drops and shutdown guard.
- `frontend/src/bridge.ts`: typed Go service calls via `Call.ByName("main.App.Method", ...)`.
- `frontend/src/components/WindowTitleBar.tsx`: frameless native window controls and settings.
- `frontend/src/App.tsx`: preserves tabs, session tree, SFTP uploads and confirmation UI.
- `Taskfile.yml`: production Windows build entrypoint.
- CI/release: Wails v3 binding generation, syso resources and Go Windows build.

## Requirements

- Go 1.26 or later
- Node.js 22
- Wails v3.0.0 CLI installed through
  `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0`
- Windows WebView2 runtime
- Python with Pillow for existing icon-generation scripts, if needed

## Local development

```powershell
go mod tidy
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0
cd frontend
npm ci
cd ..
wails3 dev
```

## Production build

```powershell
wails3 build
```

The executable is built at `build/bin/OpenShell.exe`; existing release packaging retains this path.

## Verification before merge

1. Run `go test ./...`, `go vet ./...` and `npm test -- --run`.
2. Build on Windows amd64, verify icons and no extra console windows.
3. Test window drag/resize, double-click to maximize, controls, Windows 11 snapping.
4. Test terminal keyboard focus, copy/paste, tab drag/split, quick commands.
5. Test session-close/quit confirmation and active SSH disconnect.
6. Test native dialogs, SFTP upload from drag/drop, rz/sz/trz/tsz transfer progress.
7. Test light/dark themes and Chinese/English strings.

This branch is a migration candidate, not a published release. The experimental
WebView2 composition-hosting caption-button mode is deliberately disabled.
