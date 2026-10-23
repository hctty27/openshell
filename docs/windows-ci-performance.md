# Windows CI / Release performance

The Windows release workflow is responsible for producing both the portable ZIP
and NSIS installer. Never skip executable/icon verification or alter release
publishing semantics just to reduce build time.

## Caches

| Key | Cached paths | Invalidation |
| --- | --- | --- |
| `windows-wails-cli-v2.17.0-go<version>-<arch>` | `$(go env GOPATH)/bin/wails.exe` | Wails CLI version, effective Go version, Windows architecture |
| `windows-app-icons-v1-<hash>` | Resized `build/appicon.png`, `build/windows/icon.ico`, `frontend/public/app-icon.png` | Source `build/appicon.png` or `scripts/generate_app_icons.py` |
| Existing `windows-go-modules-v1-...` | Go module cache only | `go.sum` |

The Wails CLI cache is optional. If it is missing, the workflow executes the
pinned `go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.0` and checks
that the binary exists. It is important that the key include the Go toolchain
version; binaries should not be reused across unrelated Go toolchains.

The generated icon cache contains the same outputs as running
`python scripts/generate_app_icons.py`. On a miss the workflow installs pinned
`Pillow==11.3.0`, regenerates the resources and validates their existence.
Subsequent executable/NSIS icon checks *still compare the icon bytes actually
embedded into the built Windows binaries*. To regenerate an updated icon
locally, install Pillow and run that script; the cache will invalidate when
either the source icon or the generation script changes.

The Go module cache is deliberately **not** expanded to include `GOCACHE`
yet. Its last published release restore transferred approximately 367 MiB and
took 38 seconds. Adding compiler outputs could make the transfer larger; do
not change caching without measuring both cold and warm runs.

## Release dry-run safety

A PR changing `.github/workflows/windows-release.yml` now runs the same Windows
installer build, but with no `publish` input. GitHub Release creation and
the “keep latest three Releases” deletion step explicitly require both
`inputs.publish` and a non-PR event. The dry run uploads build artifacts for
review, **not** a new GitHub Release.

The Windows smoke workflow also runs Go tests, SSH repetition tests, and an
unsigned EXE build. The release dry run additionally exercises NSIS installer
creation and installer icon validation. Both remain required for workflow PRs.

## Timings and methodology

Use GitHub Actions job and step `started_at`/`completed_at` values rather
than estimating timings from logs. Measure total Windows release job duration,
the Wails CLI cache restore and install steps, icon cache restore and
generation, NSIS installer build, and artifact upload. Report cold and warm
results separately.

Baseline: v0.1.49 release Windows job, 4m03s; Wails CLI install 31s,
Pillow + icons 27s, module cache restore 38s.

PR #51 first (cold cache) Windows release dry run: 3m52s; Wails CLI install
51s, icon generation 8s, module cache restore 39s. Cold results alone do not
establish meaningful acceleration. Evaluate a second run after the Wails and
icon caches have been populated. Ensure the resulting Release remains
unchanged: `v0.1.49` until the user explicitly requests a new release.
