"""Validate the actual icon resources embedded in built Windows binaries."""
from __future__ import annotations

import argparse
import struct
from pathlib import Path


def u16(data: bytes, pos: int) -> int:
    return struct.unpack_from("<H", data, pos)[0]


def u32(data: bytes, pos: int) -> int:
    return struct.unpack_from("<I", data, pos)[0]


def ico_images(data: bytes) -> dict[tuple[int, int], bytes]:
    assert len(data) >= 6 and u16(data, 0) == 0 and u16(data, 2) == 1, "invalid ICO"
    images = {}
    for i in range(u16(data, 4)):
        w, h, _, _, _, _, length, position = struct.unpack_from("<BBBBHHII", data, 6 + 16 * i)
        value = data[position:position + length]
        assert len(value) == length, "truncated ICO image"
        images[(w or 256, h or 256)] = value
    for n in (16, 32, 256):
        assert (n, n) in images, f"missing {n}px icon"
    return images


def pe_icon_groups(data: bytes) -> list[dict[tuple[int, int], bytes]]:
    assert data[:2] == b"MZ", "not a Windows executable"
    pe = u32(data, 0x3c)
    assert data[pe:pe + 4] == bytes((80, 69, 0, 0)), "invalid PE signature"
    sections = u16(data, pe + 6)
    optional_size = u16(data, pe + 20)
    optional = pe + 24
    magic = u16(data, optional)
    assert magic in (0x10b, 0x20b), "unsupported PE version"
    resources_rva = u32(data, optional + (112 if magic == 0x20b else 96) + 16)
    section_table = optional + optional_size

    def file_offset(rva: int) -> int:
        for i in range(sections):
            p = section_table + 40 * i
            virtual_size, address, raw_size, raw_offset = struct.unpack_from("<IIII", data, p + 8)
            if address <= rva < address + max(raw_size, virtual_size):
                return raw_offset + rva - address
        raise AssertionError(f"RVA {rva:#x} outside PE sections")

    root = file_offset(resources_rva)

    def children(relative: int):
        directory = root + relative
        count = u16(data, directory + 12) + u16(data, directory + 14)
        for i in range(count):
            name, pointer = struct.unpack_from("<II", data, directory + 16 + 8 * i)
            yield name & 0x7fffffff, pointer & 0x7fffffff, bool(pointer & 0x80000000)

    def payload(relative: int) -> bytes:
        rva, length = struct.unpack_from("<II", data, root + relative)
        position = file_offset(rva)
        return data[position:position + length]

    def first_language(relative: int) -> bytes:
        for _, ptr, directory in children(relative):
            return first_language(ptr) if directory else payload(ptr)
        raise AssertionError("empty icon resource")

    kinds = {kind: ptr for kind, ptr, directory in children(0)
             if directory and kind in (3, 14)}
    assert 3 in kinds and 14 in kinds, "no embedded Windows icon"
    icons = {ident: first_language(ptr) for ident, ptr, directory in children(kinds[3])
             if directory}
    groups = []
    for _, ptr, directory in children(kinds[14]):
        if not directory:
            continue
        data_group = first_language(ptr)
        images = {}
        for i in range(u16(data_group, 4)):
            w, h, _, _, _, _, _, icon_id = struct.unpack_from(
                "<BBBBHHIH", data_group, 6 + 14 * i)
            images[(w or 256, h or 256)] = icons[icon_id]
        groups.append(images)
    return groups


def verify(icon_file: Path, binary: Path) -> None:
    source = ico_images(icon_file.read_bytes())
    sizes = (16, 32, 256)
    found = pe_icon_groups(binary.read_bytes())
    assert any(all(group.get((n, n)) == source[(n, n)] for n in sizes)
               for group in found), f"icon mismatch in {binary}"
    print(f"PASS: {binary} embeds the expected 16/32/256px OpenShell icon")


if __name__ == "__main__":
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--icon", type=Path, required=True)
    args.add_argument("--exe", type=Path, nargs="+", required=True)
    opts = args.parse_args()
    for exe in opts.exe:
        verify(opts.icon, exe)
