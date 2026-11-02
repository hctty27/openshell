#!/usr/bin/env python3
"""Ensure Wails Go module, CLI cache, runtime, and lockfiles are in sync."""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GO_MOD = ROOT / "go.mod"
PACKAGE_JSON = ROOT / "frontend" / "package.json"
PACKAGE_LOCK = ROOT / "frontend" / "package-lock.json"

def check() -> None:
    go_mod = GO_MOD.read_text(encoding="utf-8")
    match = re.search(r"(?m)^\s*github\.com/wailsapp/wails/v3\s+v(\d+\.\d+\.\d+)\s*$", go_mod)
    if not match:
        raise RuntimeError("go.mod must pin a stable Wails v3 version")
    version = match.group(1)

    package = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    lock = json.loads(PACKAGE_LOCK.read_text(encoding="utf-8"))
    runtime = package["dependencies"]["@wailsio/runtime"]
    locked = lock["packages"]["node_modules/@wailsio/runtime"]
    root_locked = lock["packages"][""]["dependencies"]["@wailsio/runtime"]
    if (runtime, locked["version"], root_locked) != (version, version, version):
        raise RuntimeError("Wails Go module and frontend runtime versions are inconsistent")
    if not locked.get("integrity", "").startswith("sha512-"):
        raise RuntimeError("Wails runtime lockfile is missing SHA-512 integrity")

    go_sum = (ROOT / "go.sum").read_text(encoding="utf-8")
    if f"github.com/wailsapp/wails/v3 v{version} h1:" not in go_sum:
        raise RuntimeError("go.sum is missing the pinned Wails module checksum")

    for relative in (
        ".github/workflows/windows-release.yml",
        ".github/workflows/windows-terminal-smoke.yml",
    ):
        workflow = (ROOT / relative).read_text(encoding="utf-8")
        cli_versions = re.findall(r"go install github\.com/wailsapp/wails/v3/cmd/wails3@v(\d+\.\d+\.\d+)", workflow)
        cache_versions = re.findall(r"windows-wails-cli-v(\d+\.\d+\.\d+)-go", workflow)
        if cli_versions != [version] or cache_versions != [version]:
            raise RuntimeError(f"{relative}: CLI or cache key does not match Wails v{version}")
    print(f"Wails module, runtime, CLI and checksums match v{version}")

if __name__ == "__main__":
    check()
