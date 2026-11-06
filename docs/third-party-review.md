# Third-party distribution and license review — OpenShell

> Review status: **in progress (2026-11-07)**. This is a source/build-script inventory, **not** a completed software bill of materials (SBOM), a legal opinion, or a statement that all upstream components have passed compliance verification.

## Current Windows native-only ZMODEM distribution

The current release packaging bundles only the OpenShell-built `zmodem/rz.exe`, `zmodem/sz.exe` launchers and the OpenShell Rust `zmodem/native/zmodem-sidecar.exe`. The new strict manifest verifies their SHA-256 and rejects `msys-2.0.dll`, `lrzsz-win32` and other stale files. The installer removes the former helper directory during upgrades. Go/npm/Rust license obligations remain subject to separate review; the automated CycloneDX SBOM now inventories Go/npm/Rust dependencies, but licenses and notices still require human review.

The **historical** inventory below documents earlier MSYS2/lrzsz releases and their unresolved old-binary source attribution. Those binaries are no longer distributed by the current native-only Windows packaging; this does not retroactively settle past redistribution questions.

## Historical distribution boundary

| File or component | Origin | Current treatment | Follow-up |
| --- | --- | --- | --- |
| `OpenShell.exe` | Built from this repository (`go build`, Wails-generated resources) | First-party program; proposed SignPath scope | Verify final executable metadata and that no unreviewed proprietary binary is embedded |
| `OpenShell-vX.Y.Z-windows-x64-Setup.exe` | This repository's NSIS installer script | First-party installer; proposed SignPath scope | Verify exact content and embedded first-party signature before signing the container |
| `zmodem/rz.exe`, `zmodem/sz.exe` | Built from this repo's `cmd/zmodem-launcher` (GUI launchers) | First-party wrappers; not submitted to SignPath by current workflow | Confirm wrapper attribution and binary contents |
| `zmodem/native/rz.exe`, `zmodem/native/sz.exe` | [trzsz/lrzsz-win32](https://github.com/trzsz/lrzsz-win32), release `v0.12.21rc` | Third-party GPL-2.0 tools, bundled unchanged; **not signed with our certificate** | Verify bundled source archive / COPYING match the actual release and redistribution obligations |
| `zmodem/native/msys-2.0.dll` | Included in upstream lrzsz Windows release; derived from MSYS2 runtime | Upstream runtime DLL; **not signed with our certificate** | **Open item:** identify exact DLL build/version, relevant licenses, required notices and corresponding source availability |
| Microsoft Edge WebView2 Runtime / Windows ConPTY | Windows components required/used at runtime, not bundled by this release workflow | External/platform dependencies | Confirm treatment under SignPath's system-library rules if questioned |
| Go modules and npm packages | `go.mod`, `go.sum`, `frontend/package-lock.json` | Source dependencies used to create the app | **Automated:** CycloneDX inventories on CI; **open:** verify all detected license terms, source and attribution obligations (see [SBOM](sbom.md)) |

## Evidence already in the repository

- `scripts/prepare_zmodem_windows.ps1` pins the lrzsz upstream release to `v0.12.21rc`, verifies the downloaded ZIP with SHA-256 `dace2db172b1b5a1e5998692760a75355b254e1826718d88bae7fa3e6d7363282246bc`, and bundles `lrzsz-win32-source.zip`, `COPYING-lrzsz.txt` and `THIRD_PARTY_NOTICES.txt`.
- The source archive is pinned to commit `2e46d4258035cea45262244f59c34d0db4fae2a7`. The binary ZIP is downloaded from the upstream release, not rebuilt by OpenShell.
- The `THIRD_PARTY_NOTICES.txt` links to [MSYS2 runtime](https://github.com/msys2/msys2-runtime). Future Windows packages additionally include verbatim `CYGWIN_LICENSE`, LGPLv3 and GPLv3 reference texts from the [historical MSYS2 3.4.9 source candidate](../third_party/msys2-runtime-3.4.9/README.md), with pinned Git blob provenance. **These references do not establish corresponding-source compliance for the exact DLL**. The [historical 3.4.9-3 PKGBUILD](../third_party/msys2-runtime-3.4.9/PKGBUILD-3.4.9-3) is also retained as a build recipe reference (source tag + patch list); it is not proven to have built the embedded DLL. The lrzsz source ZIP does not include the MSYS2 DLL source.
- The upstream [lrzsz-win32 v0.12.21rc release](https://github.com/trzsz/lrzsz-win32/releases/tag/v0.12.21rc) is based on a 2020-03-01 source commit, but its binary ZIP asset was uploaded on **2023-12-03**. A [Windows PR packaging run](https://github.com/hctty27/openshell/actions/runs/41977108930) verified the bundled `msys-2.0.dll` has PE `ProductVersion=3.4.9`, `FileVersion=3.4.9`, ProductName `MSYS2`, and SHA-256 `fb6136d849fb7a28a2d9aa7684394f6d20252942f129d2ea90ba709691a62bad`. This is evidence of the file and major runtime version, **not** a verified match to a specific MSYS2 source package or build revision. The [current MSYS2 runtime listing](https://packages.msys2.org/packages/msys2-runtime) reports `GPL-3.0-or-later`, but that does **not** establish the exact old `msys-2.0.dll` revision or licensing. Identification is still pending.
- Windows packaging now verifies required ZMODEM files, records SHA-256 hashes and Windows PE version metadata for the runtime DLL in `zmodem/BUNDLED_COMPONENTS.json`; this inventory ships in future packages and can be attached independently to Releases. See [SBOM / component manifest](sbom.md).
- `build/windows/installer/openshell.nsi` includes the entire verified ZMODEM helper directory in the installer; the portable ZIP also includes that directory.
- Current SignPath workflow submits only the top-level `OpenShell.exe` and NSIS installer for signing. It does not submit upstream native helpers as separate signing requests.

## Checklist before claiming comprehensive compliance

- [x] Add repeatable Windows Go-production and npm runtime/full dependency inventories as CI CycloneDX artifacts (see [SBOM generation](sbom.md)); these do **not** include bundled upstream ZMODEM binaries.
- [ ] Review **all** identified Go/npm component licenses, exceptions and required notices; reconcile any missing metadata, transitive components and bundled binaries with the actual compiled release.
- [x] Record embedded MSYS2 runtime PE version (`3.4.9`) and SHA-256 from a reproducible Windows GitHub Actions packaging run.
- [x] Preserve a historical MSYS2 3.4.9 candidate commit and its verbatim Cygwin/LGPL/GPL licensing texts; ship those reference notices in future Windows packages without declaring a source match.
- [ ] Confirm the **exact historical MSYS2 packaging revision** and corresponding source archive matching the `3.4.9` runtime binary. Validate license terms, patches, copyrights and corresponding-source obligations; do not consider candidate reference notices a substitute for actual source fulfillment.
- [ ] Reproduce and inspect both `v1.0.0` packages on Windows; inspect the actual file manifest rather than relying on source scripts only.
- [ ] Confirm which third-party binaries are unsigned or already signed, and ensure OpenShell's Foundation certificate is not applied to them.
- [ ] Ensure the first-party binaries have `OpenShell` product-name and matching version metadata and enforce those attributes through the SignPath configuration.
- [ ] Seek professional license advice if GPL runtime linkage or redistribution obligations are ambiguous. Do not represent this inventory as formal clearance until reviewed.

## References

- [SignPath Foundation eligibility and third-party signing rules](https://signpath.org/terms)
- [lrzsz-win32 upstream repository](https://github.com/trzsz/lrzsz-win32)
- [MSYS2 runtime source](https://github.com/msys2/msys2-runtime)
- [MSYS2 runtime package metadata](https://github.com/msys2/MSYS2-packages/blob/master/msys2-runtime/PKGBUILD)
- [Cygwin licensing, LGPL and linking exception](https://cygwin.com/licensing.html)
- [Cygwin 3.4.9 release](https://github.com/cygwin/cygwin/releases/tag/cygwin-3.4.9) — potential upstream base, **not** proof that this MSYS2-patched binary was built from an identical tree

---

## 中文结论

**目前不能宣称所有第三方组件已完成授权审核。** 当前 Windows 打包已经不包含旧版 lrzsz/MSYS2 二进制，改为仓库编译的 Rust ZMODEM sidecar 和自研启动器。Go/npm 依赖已有自动 SBOM，但仍需人工核对许可证义务；Rust 传递依赖现已加入自动 SBOM，但仍需人工审核许可证。历史 `msys-2.0.dll` 的对应源码与许可问题保留在历史记录中，不能误认为它仍随当前安装包分发。

SignPath Foundation 证书只能为项目自身构建的二进制签名，不能把原版第三方 `rz.exe`、`sz.exe` 或 `msys-2.0.dll` 作为 OpenShell 自己的程序签名。
