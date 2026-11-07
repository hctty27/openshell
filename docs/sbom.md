# OpenShell SBOM & third-party verification (Windows x64)

> **Status: automated inventory, NOT final license clearance.** SBOM and hashes help trace components but cannot independently prove a binary's license, source equivalence, or SignPath eligibility.

## Automated inventories

GitHub Actions workflow: [Generate third-party SBOM](../.github/workflows/sbom.yml).

| File in `openshell-sbom` Actions artifact | Coverage |
| --- | --- |
| `go-windows-amd64.cdx.json` | Go application modules under Windows amd64 production build constraints; CycloneDX via pinned `cyclonedx-gomod` v1.12.0 |
| `frontend-runtime.cdx.json` | Installed npm production dependency graph via Node/npm's `npm sbom --omit=dev` |
| `frontend-all.cdx.json` | Full installed npm graph, including build and development dependencies |
| `rust-zmodem.cdx.json` | Native Rust ZMODEM Cargo dependency graph for Windows x64 via pinned `cargo-cyclonedx` 0.5.9 |
| `license-review.json` | Count of components lacking explicit or evidence-only license metadata, with names, versions and package URLs |

- These files are **workflow artifacts**, retained for 30 days; they are not automatically published as long-term GitHub Release assets.
- The native Rust ZMODEM dependency SBOM is generated from `experiments/native-zmodem/Cargo.toml` with the committed `experiments/native-zmodem/Cargo.lock` for the Windows x64 target, including pinned Windows version resource tool `winres` 0.1.12. Cargo validates `--locked` before inventory generation. It lists dependency licenses but does **not** by itself prove that Rust redistribution conditions are satisfied.
- The Go SBOM reflects cross-platform module resolution for `GOOS=windows`, `GOARCH=amd64`, `CGO_ENABLED=0`, `GOFLAGS=-tags=production`. It does not independently attest to a compiled EXE's bytes, nor to the upstream ZMODEM helpers.
- Tool-detected license names are candidates for review rather than completed legal determinations. Components with missing license metadata are left visible in `license-review.json`, not silently approved.
- To reproduce, run the workflow manually or execute its pinned Go CLI and the npm commands with the project's current locked dependencies.

## Windows ZMODEM components — native Rust release

The current Windows release packaging bundles exactly three ZMODEM executables: first-party `zmodem/rz.exe` and `zmodem/sz.exe` GUI-subsystem launchers, and `zmodem/native/zmodem-sidecar.exe` built from the Rust sources in this repository. Both launchers forward stdin/stdout to the Rust protocol engine. The terminal detector from `trzsz-go` remains to support `trz/tsz` and remote-initiated `rz/sz`, but **neither lrzsz-win32 executables nor MSYS2 DLLs are distributed**.

`scripts/prepare_native_zmodem_windows.ps1` clears the release staging folder, builds the two launchers and copies the verified Rust sidecar. `scripts/generate_native_zmodem_manifest.py` records SHA-256, origin and size of the three binaries in `zmodem/BUNDLED_COMPONENTS.json`. `scripts/verify_native_only_zmodem_windows.ps1` rejects any unexpected files, including old DLLs/source archives. The installer removes old `zmodem` helpers during an upgrade.

When SignPath release signing is enabled, the three first-party helpers are signed **before** packaging. The SHA-256 manifest is then regenerated against the signed bytes so both the portable ZIP and installer carry consistent hashes. The manifest is a file inventory, **not** a comprehensive Rust/Go/npm license clearance. Those dependencies still require their own review.

## Historical ZMODEM components (previous MSYS2/lrzsz releases)

The following information documents **prior** Windows packages only; it does not describe the native-only packages built by the current release workflow.



The Windows release workflow already pins the [lrzsz-win32](https://github.com/trzsz/lrzsz-win32/releases/tag/v0.12.21rc) source commit and archive checksum and verifies the downloaded ZIP. It also pins the exact MSYS2 3.4.9 DLL SHA-256 and bundles the [historical candidate's licensing reference texts and 3.4.9-3 build recipe](../third_party/msys2-runtime-3.4.9/README.md). The historical recipe points at the upstream Cygwin source tag and MSYS2 patches but is **not** evidence of a binary/source hash match. It now also runs `scripts/generate_zmodem_manifest.py`, which:

1. Ensures the `rz.exe` and `sz.exe` OpenShell launchers, upstream native `rz.exe`/`sz.exe`, `msys-2.0.dll`, GPL copying text, upstream source ZIP and notices are present and nonempty.
2. Checks the included GPL v2 text and ensures the notices match the pinned upstream release, source commit and binary archive checksum from the packaging script.
3. Records SHA-256, file size and declared origin for each component in `zmodem/BUNDLED_COMPONENTS.json`. The Windows package build also records PE version fields for `msys-2.0.dll` and confirms they refer to the same SHA-256. The report marks the MSYS2 source candidate as **unverified**.
4. Includes this JSON inside **both** the next portable ZIP and NSIS installer. A copy is also attached to future GitHub Releases as `OpenShell-vX.Y.Z-windows-x64-zmodem-manifest.json`.

**The manifest records what was packaged, not evidence that the DLL has a verified matching source revision.** OpenShell does not apply its own SignPath Foundation certificate to upstream native ZMODEM binaries or DLLs.

## Open MSYS2 runtime issue

The upstream lrzsz-win32 source commit was dated **2020-03-01**, while its Windows Release ZIP asset was uploaded on **2023-12-03**. That ZIP contains `msys-2.0.dll`. [MSYS2's current package listing](https://packages.msys2.org/packages/msys2-runtime) indicates `GPL-3.0-or-later` for the *current* runtime package; [MSYS2 license guidance](https://www.msys2.org/license/) notes that the distribution has different licensing for its components. **Do not extrapolate current package license or revision to the exact DLL shipped in the 2023 asset.**

**Recorded binary evidence (Windows packaging run [#41977108930](https://github.com/hctty27/openshell/actions/runs/41977108930)):** `msys-2.0.dll` PE `FileVersion=3.4.9`, `ProductVersion=3.4.9`, `ProductName=MSYS2`, `CompanyName=Red Hat`, SHA-256 `fb6136d849fb7a28a2d9aa7684394f6d20252942f129d2ea90ba709691a62bad`. The `CYGWIN_LICENSE` and related source/licensing information for an **exact matching MSYS2 build** have not yet been verified. Cygwin's [licensing guidance](https://cygwin.com/licensing.html) identifies LGPLv3+ with an exception for its API library, while MSYS2 package metadata may display an overall GPL identifier; do not assert either as definitive for the unverified 2023 DLL. <https://github.com/cygwin/cygwin/releases/tag/cygwin-3.4.9> is an upstream release candidate for further investigation, not a verified identical MSYS2-patched build.

Review procedure:

1. Download the exact pinned ZIP and compare its SHA-256 to the existing preparation script's pinned value. Extract the DLL and record its SHA-256 and PE file version/embedded build information if available.
2. Find the matching historical MSYS2 runtime binary package, and compare the DLL SHA-256 or another independently reproducible version identifier. A similar filename alone is insufficient.
3. Fetch corresponding historical source/patch package and validate its license requirements, copyright, notice text and source distribution obligations.
4. If the historical DLL cannot be attributed, **do not claim clearance**. Consider switching to a reproducible upstream build with pinned runtime/source and correct notices, or removing prebundled helpers until resolved.
5. Confirm the full Windows installer and portable ZIP retain all necessary third-party notices, sources and manifests. Independently inspect actual final packages before filing the SignPath application.

## Security and change control

- A successful SBOM workflow proves the parsers can read the generated graphs, not that all license terms have been met.
- Any new upstream binary or DLL must update preparation-script origin/pin, corresponding sources, notices, and acceptance checks.
- Do not upload API tokens, private SSH keys, or user diagnostic ZIP files as SBOM artifacts.
- Original `v1.0.0` files are unaffected by these changes. The manifest and attached SBOM process apply only to builds produced after the changes are merged.

## 中文摘要

通过新增工作流，生成 Go Windows 生产依赖以及 npm 运行时/全量依赖的 CycloneDX SBOM，并自动输出**缺少许可证信息的待审核清单**，不会将其判定为已授权。

当前原生 Windows 发行包内置 `zmodem/BUNDLED_COMPONENTS.json`，记录三个项目自建 ZMODEM 程序的 SHA-256、大小及来源；Release 同时附一份清单。当前包已移除旧版 `msys-2.0.dll`。Rust 传递依赖已纳入 CycloneDX SBOM，但许可证仍待人工审核；历史 DLL 的对应源码与许可问题仅作为旧版本记录继续跟进。
