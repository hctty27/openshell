# Third-party distribution and license review — OpenShell

> Review status: **in progress (2026-11-05)**. This is a source/build-script inventory, **not** a completed software bill of materials (SBOM), a legal opinion, or a statement that all upstream components have passed compliance verification.

## Distribution boundary

| File or component | Origin | Current treatment | Follow-up |
| --- | --- | --- | --- |
| `OpenShell.exe` | Built from this repository (`go build`, Wails-generated resources) | First-party program; proposed SignPath scope | Verify final executable metadata and that no unreviewed proprietary binary is embedded |
| `OpenShell-vX.Y.Z-windows-x64-Setup.exe` | This repository's NSIS installer script | First-party installer; proposed SignPath scope | Verify exact content and embedded first-party signature before signing the container |
| `zmodem/rz.exe`, `zmodem/sz.exe` | Built from this repo's `cmd/zmodem-launcher` (GUI launchers) | First-party wrappers; not submitted to SignPath by current workflow | Confirm wrapper attribution and binary contents |
| `zmodem/native/rz.exe`, `zmodem/native/sz.exe` | [trzsz/lrzsz-win32](https://github.com/trzsz/lrzsz-win32), release `v0.12.21rc` | Third-party GPL-2.0 tools, bundled unchanged; **not signed with our certificate** | Verify bundled source archive / COPYING match the actual release and redistribution obligations |
| `zmodem/native/msys-2.0.dll` | Included in upstream lrzsz Windows release; derived from MSYS2 runtime | Upstream runtime DLL; **not signed with our certificate** | **Open item:** identify exact DLL build/version, relevant licenses, required notices and corresponding source availability |
| Microsoft Edge WebView2 Runtime / Windows ConPTY | Windows components required/used at runtime, not bundled by this release workflow | External/platform dependencies | Confirm treatment under SignPath's system-library rules if questioned |
| Go modules and npm packages | `go.mod`, `go.sum`, `frontend/package-lock.json` | Source dependencies used to create the app | **Open item:** generate complete license/SBOM inventory for exact locked versions and check attribution/re-distribution requirements |

## Evidence already in the repository

- `scripts/prepare_zmodem_windows.ps1` pins the lrzsz upstream release to `v0.12.21rc`, verifies the downloaded ZIP with SHA-256 `dace2db172b1b5a1e5998692760a75355b254e1826718d88bae7fa3e6d7363282246bc`, and bundles `lrzsz-win32-source.zip`, `COPYING-lrzsz.txt` and `THIRD_PARTY_NOTICES.txt`.
- The source archive is pinned to commit `2e46d4258035cea45262244f59c34d0db4fae2a7`. The binary ZIP is downloaded from the upstream release, not rebuilt by OpenShell.
- The `THIRD_PARTY_NOTICES.txt` links to the [MSYS2 runtime](https://github.com/msys2/msys2-runtime) but the script does not currently bundle an exact-version MSYS2 source archive or separate runtime license notices. Do not assume the lrzsz source archive covers the DLL's redistribution requirements.
- `build/windows/installer/openshell.nsi` includes the entire verified ZMODEM helper directory in the installer; the portable ZIP also includes that directory.
- Current SignPath workflow submits only the top-level `OpenShell.exe` and NSIS installer for signing. It does not submit upstream native helpers as separate signing requests.

## Checklist before claiming comprehensive compliance

- [ ] Inventory **all** effective locked Go and npm dependencies (including transitive and bundled binaries); archive license identities and notice obligations, plus any exceptions.
- [ ] Confirm the precise MSYS2 runtime revision used in the upstream binary release. Record its license(s), source location, copyright and distribution requirements; add required notices/source-offer artifacts to both portable and installer packages as necessary.
- [ ] Reproduce and inspect both `v1.0.0` packages on Windows; inspect the actual file manifest rather than relying on source scripts only.
- [ ] Confirm which third-party binaries are unsigned or already signed, and ensure OpenShell's Foundation certificate is not applied to them.
- [ ] Ensure the first-party binaries have `OpenShell` product-name and matching version metadata and enforce those attributes through the SignPath configuration.
- [ ] Seek professional license advice if GPL runtime linkage or redistribution obligations are ambiguous. Do not represent this inventory as formal clearance until reviewed.

## References

- [SignPath Foundation eligibility and third-party signing rules](https://signpath.org/terms)
- [lrzsz-win32 upstream repository](https://github.com/trzsz/lrzsz-win32)
- [MSYS2 runtime source](https://github.com/msys2/msys2-runtime)
- [MSYS2 runtime package metadata](https://github.com/msys2/MSYS2-packages/blob/master/msys2-runtime/PKGBUILD)

---

## 中文结论

**目前不能宣称所有第三方组件已完成授权审核。** OpenShell 的发布脚本已经锁定 lrzsz 二进制 SHA-256，并附带 lrzsz 的 GPL 许可证、上游源码压缩包和说明。尚需核对 `msys-2.0.dll` 的实际版本、对应源码与许可义务；同时应针对 `go.mod` 和 `frontend/package-lock.json` 生成完整依赖清单。

SignPath Foundation 证书只能为项目自身构建的二进制签名，不能把原版第三方 `rz.exe`、`sz.exe` 或 `msys-2.0.dll` 作为 OpenShell 自己的程序签名。
