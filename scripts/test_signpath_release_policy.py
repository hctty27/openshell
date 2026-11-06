#!/usr/bin/env python3
"""Static regression checks for SignPath release-only signing safeguards."""

from pathlib import Path
import unittest
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]


class SignPathReleasePolicyTests(unittest.TestCase):
    def test_artifact_rules_require_exactly_one_binary(self):
        config = ROOT / ".signpath/artifact-configurations/initial.xml"
        root = ET.parse(config).getroot()
        namespace = {"s": "http://signpath.io/artifact-configuration/v1"}
        includes = root.findall(".//s:pe-file-set/s:include", namespace)
        self.assertEqual(len(includes), 1)
        self.assertEqual(includes[0].get("path"), "OpenShell*.exe")
        self.assertEqual(includes[0].get("min-matches"), "1")
        self.assertEqual(includes[0].get("max-matches"), "1")
        self.assertEqual(root.find(".//s:parameter", namespace).get("name"), "version")

    def test_signing_requires_trusted_published_release(self):
        workflow = (ROOT / ".github/workflows/windows-release.yml").read_text(encoding="utf-8")
        self.assertIn("secrets.SIGNPATH_API_TOKEN != '' && inputs.publish", workflow)
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertIn("github.event_name != 'pull_request'", workflow)
        self.assertIn("SIGNPATH_REQUIRED: ${{ vars.SIGNPATH_REQUIRED == 'true' }}", workflow)
        self.assertIn("SIGNPATH_REQUIRED=true but this release", workflow)
        self.assertEqual(workflow.count("signpath/github-action-submit-signing-request@v3"), 2)
        self.assertNotIn("signpath/github-action-submit-signing-request@v2", workflow)
        self.assertIn("Verify installed executable from signed installer", workflow)
        self.assertIn("scripts/verify_windows_signature.ps1", workflow)


if __name__ == "__main__":
    unittest.main()
