#!/usr/bin/env python3
"""Collect diagnostic startup phases, separately from clean timing samples."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time


spec = importlib.util.spec_from_file_location("harness", Path(__file__).with_name("bench-harness-open.py"))
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin", action="append", required=True)
    parser.add_argument("--cursor-auth-file", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    results = {}
    with tempfile.TemporaryDirectory(prefix="av-startup-profile-") as temporary:
        base = Path(temporary).resolve()
        for item in args.bin:
            name, binary = item.split("=", 1)
            root = base / name
            root.mkdir()
            cwd = root / "project"
            cwd.mkdir()
            env = harness.environment(root / "home", cwd)
            terminal = None
            first_byte = None
            original_read = os.read
            try:
                sessions = harness.prepare(name, binary, root / "home", cwd, env, 0)
                session_id, marker = sessions[0]
                if name == "cursor":
                    env.pop("CURSOR_API_KEY")
                    env.pop("CURSOR_API_ENDPOINT")
                    env["CURSOR_AUTH_TOKEN"] = json.loads(args.cursor_auth_file.read_text())["cursor"]["access"]
                elif name != "codex":
                    parser.error("Only codex and cursor can be profiled")
                terminal = harness.native.Terminal(harness.invocation(name, binary, session_id, cwd), env, cwd,
                                                   args.output / f"{name}-warmup.log")
                terminal.until(marker, timeout=45)
                terminal.close()
                terminal = None
                if name == "cursor":
                    probe = Path(__file__).with_name("native-startup-probe.cjs").resolve()
                    env["NODE_OPTIONS"] = f"--require={probe}"
                    env["AV_PROFILE_EVENTS"] = str(args.output / "cursor-events.jsonl")
                    Path(env["AV_PROFILE_EVENTS"]).write_text("")
                elif name == "codex":
                    env["RUST_LOG"] = "codex_core=debug,codex_tui=debug,codex_app_server=debug"
                started = time.perf_counter()
                wall_started = time.time()
                terminal = harness.native.Terminal(harness.invocation(name, binary, session_id, cwd), env, cwd,
                                                   args.output / f"{name}-terminal.log")
                def read(fd, count):
                    nonlocal first_byte
                    data = original_read(fd, count)
                    if fd == terminal.master and data and first_byte is None:
                        first_byte = (time.perf_counter() - started) * 1000
                    return data
                os.read = read
                terminal.until(marker, timeout=45)
                results[name] = {"first_byte_ms": first_byte, "last_reply_ms": (time.perf_counter() - started) * 1000,
                                 "wall_started": wall_started,
                                 "pid": terminal.process.pid,
                                 "native_cache_warmed": True,
                                 "note": "Diagnostic run with instrumentation, not a clean benchmark sample"}
                print(f"{name}: first output {first_byte:.0f} ms, reply {results[name]['last_reply_ms']:.0f} ms", flush=True)
                if name == "codex":
                    # Codex 0.163 writes diagnostics to SQLite in ten-second
                    # batches, not codex-tui.log. Outside the measured interval,
                    # allow that batch to commit and snapshot only our test DB.
                    time.sleep(10.5)
                    for database in (root / "home").rglob("*"):
                        if "log" in database.name.lower() and database.suffix in [".sqlite", ".sqlite3", ".db"]:
                            try:
                                with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as source:
                                    with sqlite3.connect(args.output / (name + "-" + database.name)) as destination:
                                        source.backup(destination)
                            except sqlite3.DatabaseError:
                                pass
            finally:
                os.read = original_read
                try:
                    if terminal:
                        terminal.close()
                finally:
                    harness.cleanup(env)
                    files = [p for p in (root / "home").rglob("*") if p.is_file()]
                    (args.output / f"{name}-file-index.json").write_text(json.dumps([str(p.relative_to(root)) for p in files], indent=2))
                    for log in files:
                        if log.suffix in [".log", ".jsonl"] and any(part in ["log", "logs"] for part in log.parts):
                            shutil.copyfile(log, args.output / (name + "-" + log.name))
    (args.output / "phases.json").write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
