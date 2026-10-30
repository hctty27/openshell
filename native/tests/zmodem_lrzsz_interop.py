#!/usr/bin/env python3
"""Exercise Rust ZMODEM against actual Linux lrzsz over an 8-bit-clean PTY."""
import errno
import hashlib
import os
import pathlib
import pty
import random
import subprocess
import sys
import tempfile
import termios
import threading
import time
import tty

TIMEOUT = 40


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pump(source, target):
    while True:
        try:
            data = os.read(source, 8192)
            if not data:
                return
            view = memoryview(data)
            while view:
                n = os.write(target, view)
                if n <= 0:
                    return
                view = view[n:]
        except OSError as exc:
            if exc.errno in (errno.EIO, errno.EBADF, errno.EPIPE):
                return
            raise


def exchange(binary, mode, source, destination, remote_files=()):
    master, slave = pty.openpty()
    tty.setraw(slave, termios.TCSANOW)
    if mode == "receive":
        command = ["sz", "-q", "-e", "-Z", *remote_files]
        cwd = source
        local_arg = destination
    else:
        command = ["rz", "-q", "-e", "-Z"]
        cwd = destination
        local_arg = source

    with tempfile.TemporaryFile() as local_err, tempfile.TemporaryFile() as remote_err:
        remote = subprocess.Popen(
            command, cwd=cwd, stdin=slave, stdout=slave, stderr=remote_err,
            start_new_session=True,
        )
        os.close(slave)
        local = subprocess.Popen(
            [str(binary), mode, str(local_arg)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=local_err, bufsize=0,
        )
        threads = [
            threading.Thread(
                target=pump, args=(master, local.stdin.fileno()), daemon=True,
            ),
            threading.Thread(
                target=pump, args=(local.stdout.fileno(), master), daemon=True,
            ),
        ]
        for worker in threads:
            worker.start()

        try:
            end = time.monotonic() + TIMEOUT
            while time.monotonic() < end:
                if remote.poll() is not None and local.poll() is not None:
                    break
                time.sleep(0.05)
            else:
                raise TimeoutError(f"{mode} did not finish within {TIMEOUT}s")
            if remote.returncode != 0 or local.returncode != 0:
                raise RuntimeError(
                    f"{mode}: lrzsz exited {remote.returncode}, Rust exited {local.returncode}"
                )
        except Exception:
            local_err.seek(0)
            remote_err.seek(0)
            print("Rust stderr:", local_err.read().decode(errors="replace")[-3000:])
            print("lrzsz stderr:", remote_err.read().decode(errors="replace")[-3000:])
            raise
        finally:
            if local.poll() is None:
                local.kill()
            if remote.poll() is None:
                remote.kill()
            local.wait()
            remote.wait()
            os.close(master)
            local.stdin.close()
            local.stdout.close()


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: zmodem_lrzsz_interop.py <compiled-interop-example>")
    binary = pathlib.Path(sys.argv[1]).resolve()
    if not binary.is_file():
        raise FileNotFoundError(binary)
    with tempfile.TemporaryDirectory(prefix="openshell-zmodem-") as scratch:
        root = pathlib.Path(scratch)
        sending = root / "send"
        received = root / "received"
        remote_received = root / "remote-received"
        for folder in (sending, received, remote_received):
            folder.mkdir()

        rng = random.Random(20261030)
        payload = bytes(rng.randrange(256) for _ in range(96 * 1024 + 257))
        binary_file = sending / "binary-payload.bin"
        binary_file.write_bytes(payload)
        chinese_file = sending / "中文-test.txt"
        chinese_file.write_bytes("中文 ZMODEM 多文件\n".encode() * 64)

        exchange(binary, "receive", sending, received,
                 (binary_file.name, chinese_file.name))
        for fixture in (binary_file, chinese_file):
            output = received / fixture.name
            assert output.is_file(), f"sz missing file {fixture.name}"
            assert sha256(output) == sha256(fixture), f"sz hash mismatch: {fixture.name}"
        print("PASS real sz -> Rust: multi-file, Chinese, SHA-256", flush=True)

        exchange(binary, "send", binary_file, remote_received)
        uploaded = remote_received / binary_file.name
        assert uploaded.is_file(), "rz missing uploaded file"
        assert sha256(uploaded) == sha256(binary_file), "rz hash mismatch"
        print("PASS Rust -> real rz: SHA-256 binary file", flush=True)

        existing = root / "existing"
        existing.mkdir()
        (existing / binary_file.name).write_bytes(b"KEEP MY EXISTING FILE")
        exchange(binary, "receive", sending, existing, (binary_file.name,))
        assert (existing / binary_file.name).read_bytes() == b"KEEP MY EXISTING FILE"
        print("PASS real sz -> Rust: existing files are never overwritten", flush=True)


if __name__ == "__main__":
    main()
