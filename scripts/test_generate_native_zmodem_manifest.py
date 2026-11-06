import hashlib
import tempfile
import unittest
from pathlib import Path

from scripts.generate_native_zmodem_manifest import RUST_ONLY_FILES, native_bundle_manifest


class NativeZmodemManifestTests(unittest.TestCase):
    def test_only_rust_sidecar_and_our_launchers_are_permitted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in RUST_ONLY_FILES:
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b"Rust-only " + name.encode())
            manifest = native_bundle_manifest(root)
            self.assertEqual(manifest["bundleMode"], "rust-native-only")
            self.assertFalse(manifest["msys2Bundled"])
            self.assertFalse(manifest["lrzszWin32Bundled"])
            self.assertEqual(set(RUST_ONLY_FILES), {row["path"] for row in manifest["files"]})
            for row in manifest["files"]:
                self.assertEqual(row["sha256"], hashlib.sha256((root / row["path"]).read_bytes()).hexdigest())
            (root / "BUNDLED_COMPONENTS.json").write_text("{}", encoding="utf-8")
            native_bundle_manifest(root)
            for legacy in ("native/msys-2.0.dll", "native/rz.exe", "lrzsz-win32-source.zip"):
                stale = root / legacy
                stale.write_bytes(b"legacy")
                with self.assertRaises(ValueError):
                    native_bundle_manifest(root)
                stale.unlink()
            (root / "native/zmodem-sidecar.exe").unlink()
            with self.assertRaises(ValueError):
                native_bundle_manifest(root)


if __name__ == "__main__":
    unittest.main()
