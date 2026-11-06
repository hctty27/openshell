#!/usr/bin/env python3
"""Verify standalone sidecar binaries exchange files over native OS pipes.

This runs on Windows and Linux. It is NOT a remote SSH/PTy compatibility test.
"""

from pathlib import Path
import sys
import tempfile

from interop_lrzsz import sha256, transfer_pair


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: interop_sidecar.py PATH_TO_ZMODEM_SIDECAR")
    sidecar = str(Path(sys.argv[1]).resolve())
    if not Path(sidecar).is_file():
        raise SystemExit("Missing sidecar EXE")

    cases = [
        ("empty.bin", b"", 4096),
        ("one.bin", b"\x00", 4096),
        ("中文数据.bin", "Windows UTF-8 ZMODEM".encode(), 4096),
        ("binary.bin", bytes((i * 149 + 31) % 256 for i in range(1_048_591)), 79),
    ]

    with tempfile.TemporaryDirectory(prefix="openshell-native-zmodem-") as root_dir:
        root = Path(root_dir)
        source_dir = root / "input"
        destination_dir = root / "output"
        source_dir.mkdir()
        destination_dir.mkdir()
        for name, contents, fragments in cases:
            source = source_dir / name
            source.write_bytes(contents)
            print(f"native sender ↔ native receiver: {name}, {len(contents)} bytes", flush=True)
            transfer_pair(
                [sidecar, "send", str(source)],
                [sidecar, "receive", str(destination_dir)],
                source_dir,
                destination_dir,
                fragments,
            )
            destination = destination_dir / name
            assert destination.exists() and sha256(destination) == sha256(source)

        # A second pair of native peers must share one batch session and keep
        # filename boundaries intact, including UTF-8 and spaces.
        batch = [
            ("batch-one.bin", b"alpha" * 1000),
            ("batch space.bin", b"beta" * 2000),
            ("批量文档.bin", b"gamma" * 300),
        ]
        sources = []
        for filename, payload in batch:
            path = source_dir / filename
            path.write_bytes(payload)
            sources.append(path)
        transfer_pair(
            [sidecar, "send", *(str(p) for p in sources)],
            [sidecar, "receive", str(destination_dir)],
            source_dir, destination_dir, 97,
        )
        for source in sources:
            target = destination_dir / source.name
            assert target.exists() and sha256(target) == sha256(source)

        # Verify the exact Go/Wails process invocation: a bounded NUL list.
        manifest_dir = root / "manifest-output"
        manifest_dir.mkdir()
        manifest = root / "upload.list"
        manifest.write_bytes(b"".join(str(p).encode("utf-8") + b"\x00" for p in sources))
        transfer_pair(
            [sidecar, "send-list", str(manifest)],
            [sidecar, "receive", str(manifest_dir)],
            source_dir, manifest_dir, 97,
        )
        for source in sources:
            target = manifest_dir / source.name
            assert target.exists() and sha256(target) == sha256(source)

    print(f"Passed: {len(cases) + 6} native-sidecar SHA-256 file checks, including batch and manifest sessions")


if __name__ == "__main__":
    main()
