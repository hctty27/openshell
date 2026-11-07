#!/usr/bin/env python3
"""Synchronize OpenShell release metadata for a one-click release."""

import argparse
import json
import re
import subprocess
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
VERSION_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")


def next_version(current: str, bump: str) -> str:
    match = VERSION_RE.fullmatch(current)
    if not match:
        raise ValueError(f"Invalid release version: {current}")
    major, minor, patch = map(int, match.groups())
    if bump == "major":
        return f"{major + 1}.0.0"
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    if bump == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise ValueError(f"Unknown version bump: {bump}")


def update_version_field(path: Path, version: str, count: int) -> None:
    source = path.read_text(encoding="utf-8")
    result, changed = re.subn(
        r'(?m)^(\s*"version":\s*)"[^"]+"',
        lambda match: f'{match.group(1)}"{version}"',
        source,
        count=count,
    )
    if changed != count:
        raise ValueError(f"Expected {count} version fields in {path}")
    json.loads(result)
    path.write_text(result, encoding="utf-8")


def update_changelog(previous_tag: str, version: str) -> None:
    path = ROOT / "CHANGELOG.md"
    source = path.read_text(encoding="utf-8")
    heading = "## 未发布"
    if source.count(heading) != 1:
        raise ValueError("CHANGELOG.md must contain exactly one unreleased heading")

    upcoming, separator, old = source.partition(heading)
    next_heading = re.search(r"(?m)^## \d+\.\d+\.\d+\b", old)
    if not separator or not next_heading:
        raise ValueError("Cannot find existing version sections in CHANGELOG.md")

    unreleased_notes = old[:next_heading.start()].strip()
    if not unreleased_notes:
        history = subprocess.run(
            ["git", "log", f"{previous_tag}..HEAD", "--format=%s"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.splitlines()
        entries = [
            f"- {message.strip()}"
            for message in history
            if message.strip()
            and not message.startswith(("chore(release):", "Merge pull request"))
        ]
        unreleased_notes = "\n".join(entries[:20]) or "- 版本维护与稳定性更新。"

    date = datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()
    section = f"\n\n## {version} — {date}\n\n{unreleased_notes}\n\n"
    path.write_text(upcoming + heading + section + old[next_heading.start():], encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bump", choices=("patch", "minor", "major"), default="patch")
    args = parser.parse_args()

    marker = ROOT / ".github/release-version.txt"
    current_tag = marker.read_text(encoding="utf-8").strip()
    package = ROOT / "frontend/package.json"
    lock = ROOT / "frontend/package-lock.json"
    package_version = json.loads(package.read_text(encoding="utf-8"))["version"]
    lock_data = json.loads(lock.read_text(encoding="utf-8"))
    if current_tag != f"v{package_version}" or (
        lock_data["version"] != package_version
        or lock_data["packages"][""]["version"] != package_version
    ):
        raise ValueError("Release marker, package.json and package-lock.json do not match")

    version = next_version(current_tag, args.bump)
    update_changelog(current_tag, version)
    update_version_field(package, version, 1)
    update_version_field(lock, version, 2)
    marker.write_text(f"v{version}\n", encoding="utf-8")

    info = ROOT / "build/windows/info.json"
    metadata = json.loads(info.read_text(encoding="utf-8"))
    metadata["fixed"]["file_version"] = version
    metadata["info"]["0409"]["ProductVersion"] = version
    info.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Prepared OpenShell v{version}")


if __name__ == "__main__":
    main()
