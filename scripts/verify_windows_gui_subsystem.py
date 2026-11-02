#!/usr/bin/env python3
"""Ensure the packaged Windows app uses the GUI PE subsystem (no CMD window)."""

import argparse
from pathlib import Path
import struct

IMAGE_SUBSYSTEM_WINDOWS_GUI = 2


def read_subsystem(path: Path) -> int:
    with path.open("rb") as binary:
        if binary.read(2) != b"MZ":
            raise ValueError("missing DOS MZ signature")
        binary.seek(0x3C)
        pe_offset_bytes = binary.read(4)
        if len(pe_offset_bytes) != 4:
            raise ValueError("truncated DOS header")
        pe_offset = struct.unpack("<I", pe_offset_bytes)[0]
        binary.seek(pe_offset)
        if binary.read(4) != b"PE\\x00\\x00":
            raise ValueError("missing PE signature")
        coff_header = binary.read(20)
        if len(coff_header) != 20:
            raise ValueError("truncated COFF header")
        optional_header_size = struct.unpack_from("<H", coff_header, 16)[0]
        if optional_header_size < 70:
            raise ValueError("truncated PE optional header")
        optional_header = binary.read(optional_header_size)
        if len(optional_header) != optional_header_size:
            raise ValueError("truncated PE optional header")
        magic = struct.unpack_from("<H", optional_header)[0]
        if magic not in (0x10B, 0x20B):
            raise ValueError(f"unsupported PE optional header magic: 0x{magic:04x}")
        return struct.unpack_from("<H", optional_header, 68)[0]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    args = parser.parse_args()
    subsystem = read_subsystem(args.executable)
    if subsystem != IMAGE_SUBSYSTEM_WINDOWS_GUI:
        parser.error(
            f"{args.executable}: PE subsystem={subsystem}; expected GUI subsystem "
            f"{IMAGE_SUBSYSTEM_WINDOWS_GUI}. Add -H windowsgui to go build -ldflags."
        )
    print(f"{args.executable}: Windows GUI subsystem verified (2).")


if __name__ == "__main__":
    main()
