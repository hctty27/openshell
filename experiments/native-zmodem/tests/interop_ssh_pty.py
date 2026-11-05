#!/usr/bin/env python3
"""Real SSH PTY ZMODEM interoperability against a loopback OpenSSH server.

Both directions run through an authenticated SSH channel with an allocated PTY.
The OpenShell terminal and production trzsz filter remain unchanged.
"""

import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def invoke(bridge: str, sidecar: str, address: str, user: str,
           private_key: str, host_key: str, direction: str,
           local: Path, remote: Path) -> None:
    command = [
        bridge, "-addr", address, "-user", user, "-identity", private_key,
        "-hostkey", host_key, "-sidecar", sidecar, "-timeout", "45s",
        direction, str(local), str(remote),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=55)
    if result.returncode:
        raise AssertionError(
            f"SSH PTY {direction} failed (exit {result.returncode}): "
            f"stdout={result.stdout!r}, stderr={result.stderr!r}"
        )


def main() -> None:
    if len(sys.argv) != 7:
        raise SystemExit(
            "Usage: interop_ssh_pty.py BRIDGE SIDECAR HOST:PORT USER CLIENT_KEY HOST_KEY_PUB"
        )
    bridge, sidecar, address, user, client_key, host_key = sys.argv[1:]
    with tempfile.TemporaryDirectory(prefix="openshell-zmodem-ssh-") as temporary:
        root = Path(temporary)
        local_source = root / "local-source"
        local_download = root / "local-download"
        remote_source = root / "remote-source"
        remote_receive = root / "remote-receive's space"
        for path in (local_source, local_download, remote_source, remote_receive):
            path.mkdir()
        cases = [
            ("empty.bin", b""),
            ("one.bin", b"x"),
            ("binary.bin", bytes((i * 197 + 17) % 256 for i in range(64 * 1024 + 13))),
            ("中文文件.bin", "Windows native ZMODEM over SSH PTY".encode()),
            ("large.bin", bytes((i * 97 + 31) % 256 for i in range(1024 * 1024 + 37))),
        ]
        for name, payload in cases:
            upload = local_source / name
            upload.write_bytes(payload)
            invoke(bridge, sidecar, address, user, client_key, host_key,
                   "send", upload, remote_receive)
            received = remote_receive / name
            assert received.is_file() and digest(upload) == digest(received), name
            print(f"SSH PTY Rust send -> remote Linux rz: {name} SHA-256 OK", flush=True)

            remote_file = remote_source / name
            remote_file.write_bytes(payload)
            invoke(bridge, sidecar, address, user, client_key, host_key,
                   "receive", local_download, remote_file)
            downloaded = local_download / name
            assert downloaded.is_file() and digest(remote_file) == digest(downloaded), name
            print(f"SSH PTY remote Linux sz -> Rust receive: {name} SHA-256 OK", flush=True)
        print(f"Passed: {len(cases) * 2} real SSH PTY transfers", flush=True)


if __name__ == "__main__":
    main()
