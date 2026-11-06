#!/usr/bin/env python3
"""Validate CycloneDX inventories and report unresolved license metadata."""

import argparse
import json
from pathlib import Path


def read_inventory(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as stream:
        data = json.load(stream)
    if data.get("bomFormat") != "CycloneDX":
        raise ValueError(f"{path}: expected CycloneDX JSON")
    if not isinstance(data.get("components"), list) or not data["components"]:
        raise ValueError(f"{path}: no dependency components found")

    unknown = []
    for component in data["components"]:
        if not isinstance(component, dict) or not component.get("name"):
            raise ValueError(f"{path}: malformed component")
        direct = component.get("licenses") or []
        evidence = (component.get("evidence") or {}).get("licenses") or []
        if not direct and not evidence:
            unknown.append({
                "name": component["name"],
                "version": component.get("version", ""),
                "purl": component.get("purl", ""),
            })

    return {
        "filename": path.name,
        "componentCount": len(data["components"]),
        "missingLicenseMetadata": sorted(
            unknown, key=lambda value: (value["name"], value["version"])
        ),
    }


def create_report(go: Path, frontend_runtime: Path, frontend_all: Path, rust: Path | None = None) -> dict:
    inventories = {
        "goWindowsAmd64": read_inventory(go),
        "frontendRuntime": read_inventory(frontend_runtime),
        "frontendAll": read_inventory(frontend_all),
    }
    if rust is not None:
        inventories["rustWindowsAmd64"] = read_inventory(rust)
    if inventories["frontendRuntime"]["componentCount"] > inventories["frontendAll"]["componentCount"]:
        raise ValueError("runtime dependency count exceeds full frontend dependency count")
    return {
        "schemaVersion": 1,
        "reviewStatus": "pending-manual-review",
        "scope": (
            "Go Windows amd64 production app, frontend runtime/full dependency trees, "
            "and optional native Rust ZMODEM Windows target dependencies. These SBOMs "
            "do not themselves prove that any third-party license obligations are fulfilled."
        ),
        "licenseDisclaimer": (
            "Tool-detected license strings are evidence, not a legal determination. "
            "Missing license metadata does not prove a dependency is unlicensed."
        ),
        "inventories": inventories,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--go", required=True, type=Path)
    parser.add_argument("--frontend-runtime", required=True, type=Path)
    parser.add_argument("--frontend-all", required=True, type=Path)
    parser.add_argument("--rust", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = create_report(args.go, args.frontend_runtime, args.frontend_all, args.rust)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    for key, inventory in report["inventories"].items():
        print(
            f"{key}: {inventory['componentCount']} components; "
            f"{len(inventory['missingLicenseMetadata'])} need license review"
        )


if __name__ == "__main__":
    main()
