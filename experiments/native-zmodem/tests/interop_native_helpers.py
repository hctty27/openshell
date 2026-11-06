#!/usr/bin/env python3
"""Windows-only native ZMODEM helper compatibility proof.

Uses actual Go GUI-subsystem rz.exe/sz.exe wrappers without MSYS2 or lrzsz.
This proves inherited stdio and pinned trzsz-go CLI arguments, but does not
replace end-user interactive Wails or SSH acceptance.
"""

from pathlib import Path
import sys
import tempfile

from interop_lrzsz import sha256, transfer_pair


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: interop_native_helpers.py PATH_TO_RUST_SIDECAR PATH_TO_HELPER_DIR")
    sidecar = str(Path(sys.argv[1]).resolve())
    helpers = Path(sys.argv[2]).resolve()
    rz = str(helpers / "rz.exe")
    sz = str(helpers / "sz.exe")
    for filename in [sidecar, rz, sz]:
        if not Path(filename).is_file():
            raise AssertionError(f"required native helper missing: {filename}")
    for forbidden in ["native/msys-2.0.dll", "native/rz.exe", "native/sz.exe"]:
        if (helpers / forbidden).exists():
            raise AssertionError(f"native-only build includes legacy dependency: {forbidden}")

    with tempfile.TemporaryDirectory(prefix="openshell-rust-helper-") as root_path:
        root = Path(root_path)
        source = root / "source"
        remote = root / "remote"
        downloaded = root / "downloaded"
        for directory in [source, remote, downloaded]:
            directory.mkdir()
        files = []
        for name, data in [
            ("one.bin", b"one" * 500),
            ("two files.bin", b"two" * 400),
            ("中文文件.bin", b"unicode" * 250),
        ]:
            path = source / name
            path.write_bytes(data)
            files.append(path)

        # The exact arguments passed by the pinned trzsz-go ZMODEM filter.
        transfer_pair(
            [sz, "-e", "-b", "-B", "32768", *(str(p) for p in files)],
            [sidecar, "receive", str(remote)],
            source, remote, 53,
        )
        for file in files:
            assert sha256(file) == sha256(remote / file.name)

        transfer_pair(
            [sidecar, "send", *(str(p) for p in files)],
            [rz, "-E", "-e", "-b", "-B", "32768"],
            source, downloaded, 97,
        )
        for file in files:
            assert sha256(file) == sha256(downloaded / file.name)

        # The pinned filter always supplies -E on receive. Native Rust must
        # preserve the legacy automatic rename behavior (never overwrite).
        transfer_pair(
            [sidecar, "send", str(files[0])],
            [rz, "-E", "-e", "-b", "-B", "32768"],
            source, downloaded, 97,
        )
        assert (downloaded / "one.1.bin").is_file()
        assert sha256(files[0]) == sha256(downloaded / "one.1.bin")
    print("PASS: 7 SHA-256 checks through Rust-only sz/rz wrappers without MSYS2", flush=True)


if __name__ == "__main__":
    main()
