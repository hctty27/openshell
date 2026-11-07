#!/usr/bin/env python3
"""Static regression checks for trusted SignPath signing and locked Rust builds."""

from pathlib import Path
import tomllib
import unittest
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = {"s": "http://signpath.io/artifact-configuration/v1"}
RUST_DIRECTORY = ROOT / "experiments/native-zmodem"


class SignPathReleasePolicyTests(unittest.TestCase):
    def test_app_and_installer_configuration_remains_strict(self):
        root = ET.parse(ROOT / ".signpath/artifact-configurations/initial.xml").getroot()
        includes = root.findall(".//s:pe-file-set/s:include", NAMESPACE)
        self.assertEqual(len(includes), 1)
        self.assertEqual(includes[0].get("path"), "OpenShell*.exe")
        self.assertEqual(includes[0].get("min-matches"), "1")
        self.assertEqual(includes[0].get("max-matches"), "1")
        self.assertEqual(root.find(".//s:parameter", NAMESPACE).get("name"), "version")

    def test_native_helper_configuration_signs_only_three_first_party_executables(self):
        root = ET.parse(ROOT / ".signpath/artifact-configurations/native-helpers.xml").getroot()
        paths = root.findall("./s:zip-file/s:pe-file", NAMESPACE)
        self.assertEqual(
            [entry.get("path") for entry in paths],
            ["rz.exe", "sz.exe", "native/zmodem-sidecar.exe"],
        )
        self.assertEqual(root.find("./s:parameters/s:parameter", NAMESPACE).get("name"), "version")
        for entry in paths:
            self.assertIsNotNone(entry.find("s:authenticode-sign", NAMESPACE))
            self.assertNotIn("*", entry.get("path"))
            self.assertEqual(entry.get("product-name"), "OpenShell")
            self.assertEqual(entry.get("product-version"), "${version}")
            self.assertEqual(entry.get("min-matches", "1"), "1")
            self.assertEqual(entry.get("max-matches", "1"), "1")

    def test_signing_requires_trusted_published_release(self):
        workflow = (ROOT / ".github/workflows/windows-release.yml").read_text(encoding="utf-8")
        self.assertIn("secrets.SIGNPATH_API_TOKEN != '' && inputs.publish", workflow)
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertIn("github.event_name != 'pull_request'", workflow)
        self.assertIn("SIGNPATH_REQUIRED: ${{ vars.SIGNPATH_REQUIRED == 'true' }}", workflow)
        self.assertIn("SIGNPATH_REQUIRED=true but this release", workflow)
        self.assertEqual(workflow.count("signpath/github-action-submit-signing-request@v3"), 3)
        self.assertNotIn("signpath/github-action-submit-signing-request@v2", workflow)
        self.assertIn("SIGNPATH_NATIVE_ARTIFACT_CONFIGURATION_SLUG", workflow)
        self.assertIn("info.'0409'.ProductVersion", workflow)
        with (ROOT / "build/windows/info.json").open("rb") as metadata_file:
            import json
            version_info = json.load(metadata_file)
        self.assertEqual(list(version_info["info"]), ["0409"])
        self.assertEqual(version_info["info"]["0409"]["ProductName"], "OpenShell")
        self.assertEqual(version_info["fixed"]["product_version"], "1.0.6")
        self.assertEqual(version_info["info"]["0409"]["FileVersion"], "1.0.6")
        self.assertIn("info.'0409'.FileVersion", workflow)
        bump = (ROOT / "scripts/bump_release_version.py").read_text(encoding="utf-8")
        self.assertIn('metadata["info"]["0409"]["ProductVersion"]', bump)
        self.assertIn("scripts/verify_native_zmodem_metadata.ps1", workflow)
        self.assertIn('version: "${{ env.APP_VERSION }}"', workflow)
        self.assertIn("$env:OPENSHELL_APP_VERSION = $env:APP_VERSION", workflow)

        ordering = [
            "Sign first-party native ZMODEM helpers with SignPath",
            "Replace native ZMODEM helpers with signed files",
            "Upload unsigned EXE for SignPath",
            "Create portable ZIP",
            "Verify signed portable ZIP contents",
            "Create Windows installer",
            "Sign installer with SignPath",
            "Verify installed executable from signed installer",
        ]
        positions = [workflow.index(step) for step in ordering]
        self.assertEqual(positions, sorted(positions))
        self.assertIn("scripts/verify_native_zmodem_signatures.ps1", workflow)
        self.assertIn("generate_native_zmodem_manifest.py --target $destination", workflow)
        self.assertIn("Verify installer upgrades legacy MSYS2 files to Rust only", workflow)
        self.assertIn("scripts/verify_windows_signature.ps1", workflow)

    def test_signed_helpers_are_required_in_installed_distribution(self):
        script = (ROOT / "scripts/test_native_zmodem_installer_upgrade.ps1").read_text(encoding="utf-8")
        self.assertIn("verify_native_zmodem_signatures.ps1", script)
        validator = (ROOT / "scripts/verify_native_zmodem_signatures.ps1").read_text(encoding="utf-8")
        for name in ["rz.exe", "sz.exe", "native/zmodem-sidecar.exe"]:
            self.assertIn(name, validator)
        self.assertIn("BUNDLED_COMPONENTS.json", validator)
        self.assertIn("-NativeHelper", validator)
        metadata = (ROOT / "scripts/verify_native_zmodem_metadata.ps1").read_text(encoding="utf-8")
        self.assertIn('ProductName -ne "OpenShell"', metadata)
        self.assertIn("ProductVersion -ne $Version", metadata)

    def test_rust_dependency_graph_is_locked_everywhere(self):
        with (RUST_DIRECTORY / "Cargo.lock").open("rb") as stream:
            lock = tomllib.load(stream)
        packages = {package["name"]: package for package in lock["package"]}
        self.assertEqual(packages["zmodem2"]["version"], "0.7.3")
        self.assertEqual(packages["winres"]["version"], "0.1.12")
        self.assertGreaterEqual(len(packages), 2)
        build_script = (RUST_DIRECTORY / "build.rs").read_text(encoding="utf-8")
        self.assertIn('set("ProductName", "OpenShell")', build_script)
        self.assertIn('set("ProductVersion", &version)', build_script)
        self.assertIn('set_version_info(winres::VersionInfo::PRODUCTVERSION, number)', build_script)
        for package in packages.values():
            if package.get("source", "").startswith("registry+"):
                self.assertEqual(len(package["checksum"]), 64)

        build_paths = (
            ".github/workflows/windows-release.yml",
            ".github/workflows/windows-terminal-smoke.yml",
            ".github/workflows/native-zmodem-probe.yml",
            ".github/workflows/native-zmodem-windows-linux-lab.yml",
            ".github/workflows/sbom.yml",
            "scripts/test-native-zmodem.ps1",
        )
        for relative_path in build_paths:
            with self.subTest(path=relative_path):
                script = (ROOT / relative_path).read_text(encoding="utf-8")
                self.assertNotIn("cargo generate-lockfile", script)
                self.assertIn("cargo metadata --locked", script)


if __name__ == "__main__":
    unittest.main()
