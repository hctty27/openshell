#!/usr/bin/env python3
"""Create a reproducible inventory of the Windows ZMODEM bundle."""

import argparse
import hashlib
import json
import re
from pathlib import Path


BUNDLED_FILES = {
    "rz.exe": "openshell-launcher",
    "sz.exe": "openshell-launcher",
    "native/rz.exe": "lrzsz-upstream",
    "native/sz.exe": "lrzsz-upstream",
    "native/msys-2.0.dll": "msys2-runtime-upstream",
    "COPYING-lrzsz.txt": "lrzsz-license",
    "CYGWIN_LICENSE-msys2.txt": "historical-msys2-license-reference",
    "COPYING-LGPLv3-msys2.txt": "historical-msys2-license-reference",
    "COPYING-GPLv3-msys2.txt": "historical-msys2-license-reference",
    "PKGBUILD-msys2-3.4.9-3.txt": "historical-msys2-package-recipe-reference",
    "lrzsz-win32-source.zip": "lrzsz-source",
    "THIRD_PARTY_NOTICES.txt": "third-party-notices",
}


MSYS2_SOURCE_CANDIDATE = "677ece60fc37b0c5d336db1e345a4c33ffff15f6"
MSYS2_PACKAGE_RECIPE_COMMIT = "4056de7224a47dd0249f61111351d556dfada60f"


def extract_pinned_release(script: str) -> dict:
    patterns = {
        "releaseTag": r'(?m)^\$version = "(v[^"]+)"$',
        "upstreamArchiveSHA256": r'(?m)^\$expectedSha256 = "([a-f0-9]{64})"$',
        "sourceCommit": r'lrzsz-win32/archive/([a-f0-9]{40})\.zip',
    }
    fields = {}
    for name, pattern in patterns.items():
        match = re.search(pattern, script)
        if match is None:
            raise ValueError(f"Cannot extract {name} from ZMODEM preparation script")
        fields[name] = match.group(1)
    return fields


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def create_manifest(directory: Path, preparation_script: Path) -> dict:
    pins = extract_pinned_release(preparation_script.read_text(encoding="utf-8"))
    items = []
    for relative_path, origin in sorted(BUNDLED_FILES.items()):
        path = directory / relative_path
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"Required ZMODEM bundle file missing or empty: {relative_path}")
        items.append({
            "path": relative_path,
            "origin": origin,
            "sizeBytes": path.stat().st_size,
            "sha256": sha256_file(path),
        })

    copying = (directory / "COPYING-lrzsz.txt").read_text(encoding="utf-8", errors="replace")
    if "GNU GENERAL PUBLIC LICENSE" not in copying or "Version 2" not in copying:
        raise ValueError("Bundled lrzsz license text is not the expected GPL version 2")
    notices = (directory / "THIRD_PARTY_NOTICES.txt").read_text(encoding="utf-8", errors="replace")
    for required in (pins["releaseTag"], pins["upstreamArchiveSHA256"], pins["sourceCommit"], MSYS2_SOURCE_CANDIDATE, MSYS2_PACKAGE_RECIPE_COMMIT):
        if required not in notices:
            raise ValueError("Bundled third-party notice disagrees with upstream pin: " + required)

    license_markers = {
        "CYGWIN_LICENSE-msys2.txt": "Lesser Gnu Public License",
        "COPYING-LGPLv3-msys2.txt": "GNU LESSER GENERAL PUBLIC LICENSE",
        "COPYING-GPLv3-msys2.txt": "GNU GENERAL PUBLIC LICENSE",
    }
    for filename, marker in license_markers.items():
        content = (directory / filename).read_text(encoding="utf-8", errors="replace")
        if marker.lower() not in content.lower():
            raise ValueError(f"Unexpected MSYS2 historical license reference: {filename}")

    recipe = (directory / "PKGBUILD-msys2-3.4.9-3.txt").read_text(encoding="utf-8", errors="replace")
    for expected in ("pkgver=3.4.9", "pkgrel=3", "cygwin-${pkgver}"):
        if expected not in recipe:
            raise ValueError("Unexpected historical MSYS2 PKGBUILD reference")

    return {
        "schemaVersion": 1,
        "component": "OpenShell Windows ZMODEM helpers",
        "reviewStatus": "pending-msys2-runtime-identification-and-license-review",
        "upstream": {
            "repository": "https://github.com/trzsz/lrzsz-win32",
            **pins,
            "lrzszLicenseText": "COPYING-lrzsz.txt (GNU GPL version 2)",
            "sourceArchive": "lrzsz-win32-source.zip",
            "runtimeDllLicense": "unverified-for-2023-release-asset",
            "runtimeSource": "https://github.com/msys2/msys2-runtime",
            "runtimeSourceCandidateCommit": MSYS2_SOURCE_CANDIDATE,
            "runtimeSourceCandidateVerified": False,
            "runtimePackageRecipeCommit": MSYS2_PACKAGE_RECIPE_COMMIT,
            "runtimePackageRecipeVersion": "3.4.9-3 (candidate, not matched to embedded DLL)",
            "runtimeNoticeSnapshot": "msys2-3.4.9 candidate at immutable commit; exact binary/package match unverified",
        },
        "limitations": (
            "These hashes identify files in this build; they do not prove the runtime "
            "DLL's exact upstream revision or fulfill unverified licensing duties."
        ),
        "files": items,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=Path, default=Path("build/bin/zmodem"))
    parser.add_argument(
        "--prepare-script",
        type=Path,
        default=Path("scripts/prepare_zmodem_windows.ps1"),
    )
    args = parser.parse_args()
    manifest = create_manifest(args.target, args.prepare_script)
    path = args.target / "BUNDLED_COMPONENTS.json"
    path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"ZMODEM bundle verified: {len(manifest['files'])} entries, {path}")


if __name__ == "__main__":
    main()
