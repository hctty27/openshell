# Windows CI / Release performance

The Windows release workflow is responsible for producing both the portable ZIP
and NSIS installer. Never skip executable/icon verification or alter release
publishing semantics just to reduce build time.

## Caches

| Key | Cached paths | Invalidation |
| --- | --- | --- |
| `windows-wails-cli-v2.17.0-go<version>-<arch>` | `$(go env GOPATH)/bin/wails.exe` | Wails CLI version, effective Go version, Windows architecture |
| `windows-app-icons-v1-<hash>` | Resized `build/appicon.png`, `build/windows/icon.ico`, `frontend/public/app-icon.png` | Source `build/appicon.png` or `scripts/generate_app_icons.py` |
| `setup-go@v7` combined cache | `GOMODCACHE` + `GOCACHE` | Go version and `go.sum` |

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

A separate [three-way Windows benchmark](https://github.com/hctty27/openshell/pull/52)
compared the legacy module-only cache, setup-go's combined module/build cache,
and no cache. The legacy module-only archive was about 367 MB, restored in
38 seconds and took 37 seconds to compile. A warm setup-go combined cache
restored about 258 MB in 47 seconds, but compiled in just 4 seconds, yielding
a total job time of 1m06s versus 1m49s for module-only. The combined strategy
now powers the release job; it can be cold on the first run after merging
because pull-request caches are scoped to the PR. Subsequent runs can benefit
from that cache. Do not assume every runner has identical network or CPU
performance.

It is important that setup-go uses `cache-dependency-path: go.sum` and that
the Go toolchain stays pinned by `go.mod`.

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

## Go cache A/B benchmark (PR #52)

| Strategy | Cache state | Windows Wails compile | Job duration |
| --- | --- | ---: | ---: |
| Existing module-only | hit; 367 MB | 37s | 1m49s |
| setup-go combined | cold miss | 55s | 1m37s |
| no cache | no restore | 59s | 1m37s |
| setup-go combined | warm hit; 258 MB | **4s** | **1m06s** |

All options successfully produced an EXE with verified embedded icons.
Benchmark job time includes Go setup and restore; input asset preparation ran in
a separate shared job. The warm combined-cache result was obtained by
re-running its workflow job, not by modifying the source tree.

Benchmark links:
- https://github.com/hctty27/openshell/actions/runs/39895191378
- https://github.com/hctty27/openshell/actions/runs/39895191378/attempts/2
