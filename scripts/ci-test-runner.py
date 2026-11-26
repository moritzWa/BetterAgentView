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


# These cases assert elapsed time as part of the test, not just a timeout.
# Run them without a competing terminal process so the budgets mean the same
# thing as in the original serial suite.
TIMING_TESTS = {
    "all_supported_providers_coexist_in_one_real_terminal",
    "completed_history_is_visible_by_default_and_stays_responsive",
    "hundreds_of_sessions_coalesce_arrow_bursts_without_output_backlog",
    "opencode_history_budget_stays_responsive_and_limits_visible_rows",
    "pi_launch_enters_native_foreground_and_returns_to_exact_managed_row",
    "slow_provider_refresh_does_not_block_arrow_navigation_or_exit",
}


def terminal_shards(executable):
    listing = subprocess.check_output([executable, "--list", "--format", "terse"], text=True)
    names = sorted(line.removesuffix(": test") for line in listing.splitlines() if line.endswith(": test"))
    if len(set(names)) != len(names) or len(names) < 2:
        raise RuntimeError(f"unexpected real_tty test listing: {listing!r}")
    if missing := TIMING_TESTS.difference(names):
        raise RuntimeError(f"real_tty timing tests missing from listing: {sorted(missing)}")
    parallel = [name for name in names if name not in TIMING_TESTS]
    if len(parallel) < 2:
        raise RuntimeError("not enough real_tty tests to shard")
    return (parallel[::2], parallel[1::2]), sorted(TIMING_TESTS)


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


def report_shard(label, tests, result, elapsed):
    print(f"real_tty {label}: {len(tests)} selected, took {elapsed:.1f}s", flush=True)
    print(result.stdout, end="", flush=True)
    # Catch any unexpected filter mismatch, including a zero-test pass.
    ran = re.search(r"^running (\d+) tests?$", result.stdout, re.MULTILINE)
    if not ran or int(ran[1]) != len(tests):
        print(f"real_tty {label}: expected {len(tests)} selected tests", file=sys.stderr)
        return False
    return result.returncode == 0


def run_terminal_tests(executable):
    # Keep paths short for Unix sockets. The PTY fixtures also create a fresh
    # HOME per test; the shard roots isolate anything using inherited state.
    with TemporaryDirectory(prefix="av-pty-", dir="/tmp") as root:
        shards, timing = terminal_shards(executable)
        with ThreadPoolExecutor(2) as pool:
            futures = [
                pool.submit(run_shard, executable, Path(root) / str(i), tests)
                for i, tests in enumerate(shards, start=1)
            ]
            results = [
                report_shard(f"shard {i}", tests, *future.result())
                for i, (tests, future) in enumerate(zip(shards, futures), start=1)
            ]
        results.append(report_shard(
            "serial timing tests", timing, *run_shard(executable, Path(root) / "timing", timing),
        ))
    return int(not all(results))


def main():
    executable, *args = sys.argv[1:]
    if re.fullmatch(r"real_tty-[0-9a-f]+", Path(executable).name) and not args:
        return run_terminal_tests(executable)
    os.execv(executable, [executable, *args])


if __name__ == "__main__":
    sys.exit(main())
