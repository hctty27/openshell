import json
import tempfile
import unittest
from pathlib import Path

from scripts.audit_sbom import create_report, read_inventory


class SBOMAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def bom(self, name: str, components: list) -> Path:
        path = self.root / name
        path.write_text(
            json.dumps({
                "bomFormat": "CycloneDX",
                "specVersion": "1.6",
                "components": components,
            }),
            encoding="utf-8",
        )
        return path

    def test_detects_missing_license_metadata_without_false_clearance(self):
        go = self.bom("go.json", [
            {"name": "go-lib", "version": "1", "licenses": [{"license": {"id": "MIT"}}]},
            {"name": "unknown", "version": "2"},
        ])
        runtime = self.bom("runtime.json", [
            {"name": "react", "evidence": {"licenses": [{"license": {"id": "MIT"}}]}}
        ])
        full = self.bom("all.json", [
            {"name": "react", "licenses": [{"license": {"id": "MIT"}}]},
            {"name": "vite", "version": "7"},
        ])
        report = create_report(go, runtime, full)
        self.assertEqual(report["reviewStatus"], "pending-manual-review")
        self.assertEqual(
            [component["name"] for component in report["inventories"]["goWindowsAmd64"]["missingLicenseMetadata"]],
            ["unknown"],
        )
        self.assertEqual(report["inventories"]["frontendAll"]["componentCount"], 2)

    def test_includes_rust_dependencies_when_provided(self):
        go = self.bom("go.json", [{"name": "go"}])
        runtime = self.bom("runtime.json", [{"name": "react"}])
        full = self.bom("all.json", [{"name": "react"}, {"name": "vite"}])
        rust = self.bom("rust.json", [
            {"name": "zmodem2", "version": "0.7.3", "licenses": [{"license": {"id": "MIT"}}]},
            {"name": "unknown-rust-crate", "version": "1"},
        ])
        report = create_report(go, runtime, full, rust)
        self.assertEqual(report["inventories"]["rustWindowsAmd64"]["componentCount"], 2)
        self.assertEqual(
            report["inventories"]["rustWindowsAmd64"]["missingLicenseMetadata"][0]["name"],
            "unknown-rust-crate",
        )

    def test_fails_when_components_are_empty(self):
        path = self.bom("empty.json", [])
        with self.assertRaisesRegex(ValueError, "no dependency components"):
            read_inventory(path)

    def test_fails_when_runtime_count_exceeds_all(self):
        go = self.bom("go.json", [{"name": "go"}])
        runtime = self.bom("runtime.json", [{"name": "a"}, {"name": "b"}])
        full = self.bom("full.json", [{"name": "a"}])
        with self.assertRaisesRegex(ValueError, "runtime dependency count"):
            create_report(go, runtime, full)


if __name__ == "__main__":
    unittest.main()
