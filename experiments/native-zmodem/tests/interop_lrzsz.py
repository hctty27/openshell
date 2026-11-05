#!/usr/bin/env python3
"""Pipe two independent ZMODEM processes together and verify real lrzsz transfers.

Non-production CI test: no SSH server, terminal emulator or user session involved.
"""

import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time


TIMEOUT = 30


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def transfer_pair(left: list[str], right: list[str], left_cwd: Path, right_cwd: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="zmodem-test-log-") as logs:
        with (Path(logs) / "left.err").open("wb") as left_log, (
            Path(logs) / "right.err"
        ).open("wb") as right_log:
            left_proc = subprocess.Popen(
                left,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=left_log,
                cwd=left_cwd,
                bufsize=0,
            )
            right_proc = subprocess.Popen(
                right,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=right_log,
                cwd=right_cwd,
                bufsize=0,
            )
            errors = []

            def bridge(source, sink):
                try:
                    while True:
                        data = os.read(source.fileno(), 4096)
                        if not data:
                            break
                        offset = 0
                        while offset < len(data):
                            offset += os.write(sink.fileno(), data[offset:])
                except (BrokenPipeError, OSError) as error:
                    errors.append(str(error))
                finally:
                    try:
                        sink.close()
                    except OSError:
                        pass

            threads = [
                threading.Thread(
                    target=bridge,
                    args=(left_proc.stdout, right_proc.stdin),
                    daemon=True,
                ),
                threading.Thread(
                    target=bridge,
                    args=(right_proc.stdout, left_proc.stdin),
                    daemon=True,
                ),
            ]
            for thread in threads:
                thread.start()
            try:
                # Both processes must terminate; neither is permitted to run indefinitely.
                deadline = time.monotonic() + TIMEOUT
                for process in (left_proc, right_proc):
                    process.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                left_proc.kill()
                right_proc.kill()
                left_proc.wait()
                right_proc.wait()
                raise AssertionError(
                    "ZMODEM interop timed out; "
                    f"left stderr={Path(logs, 'left.err').read_text(errors='replace')[:2000]!r}; "
                    f"right stderr={Path(logs, 'right.err').read_text(errors='replace')[:2000]!r}"
                )
            finally:
                for thread in threads:
                    thread.join(timeout=2)
            if left_proc.returncode != 0 or right_proc.returncode != 0:
                raise AssertionError(
                    f"Process failures: left={left_proc.returncode}, right={right_proc.returncode}, "
                    f"bridge={errors[:3]}; "
                    f"left stderr={Path(logs, 'left.err').read_text(errors='replace')[:2500]!r}; "
                    f"right stderr={Path(logs, 'right.err').read_text(errors='replace')[:2500]!r}"
                )


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: interop_lrzsz.py PATH_TO_ZMODEM_SIDECAR")
    sidecar = str(Path(sys.argv[1]).resolve())
    if not Path(sidecar).is_file():
        raise SystemExit("Rust sidecar executable not found")
    if not shutil.which("rz") or not shutil.which("sz"):
        raise SystemExit("lrzsz is required for the interop test")

    with tempfile.TemporaryDirectory(prefix="openshell-interop-") as root:
        root = Path(root)
        src = root / "src"
        sidecar_output = root / "sidecar-recv"
        lrzsz_output = root / "lrzsz-recv"
        for directory in (src, sidecar_output, lrzsz_output):
            directory.mkdir()

        filename = "interop.bin"
        payload = bytes((n * 191 + 11) % 256 for n in range(64 * 1024 + 17))
        source = src / filename
        source.write_bytes(payload)

        print("Test A: Linux lrzsz sz -> native Rust receiver", flush=True)
        transfer_pair(["sz", "-q", str(source)], [sidecar, "receive", str(sidecar_output)],
                      src, sidecar_output)
        received = sidecar_output / filename
        assert received.exists() and sha256(received) == sha256(source)

        print("Test B: native Rust sender -> Linux lrzsz rz", flush=True)
        transfer_pair([sidecar, "send", str(source)], ["rz", "-q", "-y"],
                      src, lrzsz_output)
        received = lrzsz_output / filename
        assert received.exists() and sha256(received) == sha256(source)

        print("Passed: bidirectional byte-for-byte lrzsz interoperability", flush=True)


if __name__ == "__main__":
    main()
