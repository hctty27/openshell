# MSYS2 runtime 3.4.9 — historical license evidence

> **Status: source candidate only — NOT binary-to-source verification or legal clearance.**

This directory contains exact, verbatim licensing text from the historical
[`msys2-3.4.9` source branch](https://github.com/msys2/msys2-runtime/tree/677ece60fc37b0c5d336db1e345a4c33ffff15f6/winsup)
in `msys2/msys2-runtime`, pinned to commit:

```
677ece60fc37b0c5d336db1e345a4c33ffff15f6
```

The commit is dated **2023-11-22**, before the `trzsz/lrzsz-win32` Windows
ZIP asset was uploaded on **2023-12-03**. It is a plausible historical
source candidate for the MSYS2 runtime version reported by the bundled DLL.

| File | Exact source path | Git blob SHA |
| --- | --- | --- |
| `CYGWIN_LICENSE` | `winsup/CYGWIN_LICENSE` | `dba58e8dbfb2a9e833d8a05b9f8cfdf808e0f992` |
| `COPYING.LIB` | `winsup/COPYING.LIB` | `65c5ca88a67c30becee01c5a8816d964b03862f9` |
| `COPYING` | `winsup/COPYING` | `94a9ed024d3859793618152ea559a168bbcbb5e2` |

Historical package recipe: [msys2/MSYS2-packages@4056de7224a47dd0249f61111351d556dfada60f](https://github.com/msys2/MSYS2-packages/blob/4056de7224a47dd0249f61111351d556dfada60f/msys2-runtime/PKGBUILD), committed **2023-11-22**, declares `pkgver=3.4.9`, `pkgrel=3`, the upstream `cygwin-3.4.9` source tag and approximately 40 MSYS2 build patches. The verbatim `PKGBUILD-3.4.9-3` copy in this directory has Git blob SHA `fb6d0308d36a01a026a68542efc58467938efc5b`. The recipe and its individual patch files are available at that immutable GitHub commit; **the patches have not been vendored into OpenShell's release**.

These are **reference license texts**, not a verified corresponding-source
distribution for the exact `msys-2.0.dll` bytes. In the Windows package they
are copied to `zmodem/` under distinct MSYS2-specific filenames.

## Embedded binary evidence

- Binary: `zmodem/native/msys-2.0.dll` from the lrzsz-win32 asset
  `v0.12.21rc` (published 2023-12-03).
- FileVersion / ProductVersion: **3.4.9** (recorded by Windows packaging CI).
- DLL SHA-256:
  `fb6136d849fb7a28a2d9aa7684394f6d20252942f129d2ea90ba709691a62bad`.
- lrzsz-win32 upstream ZIP SHA-256:
  `dace2db172b1b5a1e5998692760a75355b254e1826718d88bae7fa3a6de3c325`.
- Release CI evidence:
  https://github.com/hctty27/openshell/actions/runs/41977108930

The GitHub source commit and runtime version alone **do not** prove which
MSYS2 package revision (`3.4.9-N`) produced this DLL. Historical MSYS2
packaging revisions `3.4.9-2` and `3.4.9-3` have independent public
references, but no byte-for-byte match has been established. Current official
mirror indices no longer expose an exact `3.4.9` source package.

## Remaining compliance steps

1. Obtain the exact historical MSYS2 runtime binary package that contained
   this DLL and verify the DLL SHA-256 against the pinned fingerprint.
2. Identify its packaging revision, build logs, patches and corresponding
   source; verify that all source and licensing/notice obligations are met.
3. If exact source cannot be verified, prefer a replacement ZMODEM build with
   a documented reproducible source/runtime chain over assuming this
   snapshot is sufficient.
4. Review runtime-related LGPL/GPL requirements and distribution obligations,
   together with all other Go/npm license notices, before claiming completion.

Official references: [MSYS2 licensing](https://www.msys2.org/license/),
[Cygwin licensing](https://cygwin.com/licensing.html),
[MSYS2 runtime repository](https://github.com/msys2/msys2-runtime),
[MSYS2 packages](https://github.com/msys2/MSYS2-packages).

## 中文说明

这里的 3 份许可证原文复制自 **2023-11-22 的 MSYS2 3.4.9 候选源码快照**，
并核对 Git blob SHA。Windows 发行包会附带对应文本，但**不能据此声明已经
找到了内置 DLL 的精确对应源码**。仍须用原始 DLL SHA-256 匹配历史软件包，
审查构建补丁、完整源码及分发许可义务。
