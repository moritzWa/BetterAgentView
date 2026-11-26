#!/usr/bin/env python3
"""Cargo runner: split real_tty in two without rebuilding it or changing other tests."""

from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory
from time import monotonic


def terminal_shards(executable):
    listing = subprocess.check_output([executable, "--list", "--format", "terse"], text=True)
    names = sorted(line.removesuffix(": test") for line in listing.splitlines() if line.endswith(": test"))
    if len(set(names)) != len(names) or len(names) < 2:
        raise RuntimeError(f"unexpected real_tty test listing: {listing!r}")
    return names[::2], names[1::2]


def run_shard(executable, shard, tests):
    shard.mkdir()
    env = dict(os.environ, HOME=str(shard), TMPDIR=str(shard))
    for name in ("CACHE", "CONFIG", "DATA", "STATE"):
        env[f"XDG_{name}_HOME"] = str(shard / name.lower())
    start = monotonic()
    result = subprocess.run(
        [executable, "--exact", "--test-threads=1", *tests],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace",
    )
    return result, monotonic() - start


def run_terminal_tests(executable):
    failed = False
    # Keep paths short for Unix sockets. The PTY fixtures also create a fresh
    # HOME per test; the shard roots isolate anything using inherited state.
    with TemporaryDirectory(prefix="av-pty-", dir="/tmp") as root, ThreadPoolExecutor(2) as pool:
        shards = terminal_shards(executable)
        futures = [pool.submit(run_shard, executable, Path(root) / str(i), tests)
                   for i, tests in enumerate(shards, start=1)]
        for i, (tests, future) in enumerate(zip(shards, futures), start=1):
            result, elapsed = future.result()
            print(f"real_tty shard {i}: {len(tests)} selected, took {elapsed:.1f}s", flush=True)
            print(result.stdout, end="", flush=True)
            # Catch any unexpected filter mismatch, including a zero-test pass.
            ran = re.search(r"^running (\d+) tests?$", result.stdout, re.MULTILINE)
            if not ran or int(ran[1]) != len(tests):
                print(f"real_tty shard {i}: expected {len(tests)} selected tests", file=sys.stderr)
                failed = True
            failed |= result.returncode != 0
    return int(failed)


def main():
    executable, *args = sys.argv[1:]
    if re.fullmatch(r"real_tty-[0-9a-f]+", Path(executable).name) and not args:
        return run_terminal_tests(executable)
    os.execv(executable, [executable, *args])


if __name__ == "__main__":
    sys.exit(main())
