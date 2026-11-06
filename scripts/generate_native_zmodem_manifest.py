#!/usr/bin/env python3
"""Manifest and strict file allowlist for the Windows Rust-only ZMODEM bundle."""

import argparse
import hashlib
import json
from pathlib import Path

RUST_ONLY_FILES = {
    "rz.exe": "openshell-native-launcher",
    "sz.exe": "openshell-native-launcher",
    "native/zmodem-sidecar.exe": "openshell-rust-zmodem",
}


def native_bundle_manifest(directory: Path) -> dict:
    directory = directory.resolve()
    allowed = set(RUST_ONLY_FILES)
    allowed.add("BUNDLED_COMPONENTS.json")
    actual = {
        path.relative_to(directory).as_posix()
        for path in directory.rglob("*")
        if path.is_file()
    }
    extra = actual - allowed
    missing = set(RUST_ONLY_FILES) - actual
    if extra or missing:
        raise ValueError(
            f"Invalid native-only ZMODEM distribution: extra={sorted(extra)}, missing={sorted(missing)}"
        )
    files = []
    for name, origin in sorted(RUST_ONLY_FILES.items()):
        file = directory / name
        if file.is_symlink() or file.stat().st_size == 0:
            raise ValueError(f"Invalid native ZMODEM binary: {name}")
        files.append({
            "path": name,
            "origin": origin,
            "sizeBytes": file.stat().st_size,
            "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
        })
    return {
        "schemaVersion": 2,
        "component": "OpenShell Windows ZMODEM",
        "bundleMode": "rust-native-only",
        "msys2Bundled": False,
        "lrzszWin32Bundled": False,
        "nativeEngine": {
            "sidecar": "native/zmodem-sidecar.exe",
            "source": "experiments/native-zmodem/src/bin/zmodem-sidecar.rs",
            "enabledByDefaultOnWindows": True,
        },
        "trzszGo": "Retained for trz/tsz and terminal ZMODEM frame detection; local rz/sz processes use Rust.",
        "files": files,
        "notice": "This inventory identifies bundled files, not a full Go/Rust/npm SBOM or legal license clearance.",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=Path, default=Path("build/bin/zmodem"))
    args = parser.parse_args()
    manifest = native_bundle_manifest(args.target)
    dest = args.target / "BUNDLED_COMPONENTS.json"
    dest.write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
                    encoding="utf-8")
    print(f"Rust-only ZMODEM bundle verified: {len(manifest['files'])} binaries; manifest={dest}")


if __name__ == "__main__":
    main()
