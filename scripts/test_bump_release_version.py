"""Regression tests for automated release metadata bumps."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import bump_release_version as release


class ReleaseVersionTests(unittest.TestCase):
    def test_semver_bumps(self):
        self.assertEqual(release.next_version("v0.1.111", "patch"), "0.1.112")
        self.assertEqual(release.next_version("v0.1.111", "minor"), "0.2.0")
        self.assertEqual(release.next_version("v0.1.111", "major"), "1.0.0")
        with self.assertRaises(ValueError):
            release.next_version("0.1.111", "patch")

    def test_lockfile_only_updates_root_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "package-lock.json"
            path.write_text(
                '{\n  "name": "openshell",\n  "version": "0.1.111",\n'
                '  "packages": {"": {"version": "0.1.111"}, '
                '"node_modules/example": {"version": "7.8.9"}}\n}\n',
                encoding="utf-8",
            )
            release.update_version_field(path, "0.1.112", 2)
            updated = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(updated["version"], "0.1.112")
            self.assertEqual(updated["packages"][""]["version"], "0.1.112")
            self.assertEqual(updated["packages"]["node_modules/example"]["version"], "7.8.9")

    def test_changelog_preserves_existing_release_notes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "CHANGELOG.md"
            path.write_text(
                "# 更新记录\n\n## 未发布\n\n- 修复重要问题。\n\n"
                "## 0.1.111 — 2026-11-04\n\n- 之前的功能。\n",
                encoding="utf-8",
            )
            with patch.object(release, "ROOT", Path(directory)):
                release.update_changelog("v0.1.111", "0.1.112")
            updated = path.read_text(encoding="utf-8")
            self.assertIn("## 0.1.112", updated)
            self.assertIn("- 修复重要问题。", updated)
            self.assertIn("## 0.1.111", updated)
            self.assertIn("- 之前的功能。", updated)


if __name__ == "__main__":
    unittest.main()
