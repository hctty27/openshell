import tempfile
import unittest
from pathlib import Path

from scripts.generate_zmodem_manifest import (
    BUNDLED_FILES,
    MSYS2_SOURCE_CANDIDATE,
    MSYS2_PACKAGE_RECIPE_COMMIT,
    create_manifest,
)


class ZmodemManifestTests(unittest.TestCase):
    def test_manifest_and_missing_file(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root / "zmodem"
            target.mkdir()
            for name in BUNDLED_FILES:
                path = target / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"binary")
            (target / "COPYING-lrzsz.txt").write_text(
                "GNU GENERAL PUBLIC LICENSE\nVersion 2\n", encoding="utf-8"
            )
            for name, marker in {
                "CYGWIN_LICENSE-msys2.txt": "Lesser Gnu Public License",
                "COPYING-LGPLv3-msys2.txt": "GNU LESSER GENERAL PUBLIC LICENSE",
                "COPYING-GPLv3-msys2.txt": "GNU GENERAL PUBLIC LICENSE",
            }.items():
                (target / name).write_text(marker, encoding="utf-8")
            (target / "PKGBUILD-msys2-3.4.9-3.txt").write_text(
                "pkgver=3.4.9\npkgrel=3\nsource=cygwin-${pkgver}", encoding="utf-8"
            )
            tag = "v0.12.21rc"
            digest = "a" * 64
            revision = "b" * 40
            (target / "THIRD_PARTY_NOTICES.txt").write_text(
                tag + digest + revision + MSYS2_SOURCE_CANDIDATE + MSYS2_PACKAGE_RECIPE_COMMIT, encoding="utf-8"
            )
            pins = root / "prepare.ps1"
            pins.write_text(
                '$version = "' + tag + '"\n'
                '$expectedSha256 = "' + digest + '"\n'
                '$sourceUrl = "https://github.com/trzsz/lrzsz-win32/archive/'
                + revision + '.zip"\n',
                encoding="utf-8",
            )
            manifest = create_manifest(target, pins)
            self.assertEqual(len(manifest["files"]), len(BUNDLED_FILES))
            self.assertEqual(manifest["upstream"]["sourceCommit"], revision)
            self.assertEqual(manifest["upstream"]["runtimeSourceCandidateCommit"], MSYS2_SOURCE_CANDIDATE)
            self.assertIs(manifest["upstream"]["runtimeSourceCandidateVerified"], False)
            self.assertEqual(manifest["upstream"]["runtimePackageRecipeCommit"], MSYS2_PACKAGE_RECIPE_COMMIT)
            (target / "native/rz.exe").unlink()
            with self.assertRaises(ValueError):
                create_manifest(target, pins)


if __name__ == "__main__":
    unittest.main()
