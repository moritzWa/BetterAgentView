#!/usr/bin/env python3
"""Validate indexed Antigravity fixtures in a private Linux Space before timing.

The converter's pinned-binary installer is not a compatibility claim for this
newer CLI. Only its exact-version check is replaced in this disposable process;
all database/schema validation stays enabled. A timing requires native rendering
of the generated last reply. No profile or database outside this test is used.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import tempfile
import time
import uuid
from unittest.mock import patch

from session_migrate.formats import antigravity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--runs", type=int, default=30)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if platform.system() != "Linux":
        parser.error("Use the isolated Linux Space, not the host desktop")
    os.environ["PATH"] = str(Path.home() / ".local" / "bin") + ":" + os.environ.get("PATH", "")
    spec = importlib.util.spec_from_file_location("harness", Path(__file__).with_name("bench-harness-open.py"))
    harness = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(harness)
    result = {"status": "blocked", "platform": platform.platform(), "runs": args.runs,
              "messages_per_chat": 40, "fixture": "Validated conversation database plus native picker summary index"}
    terminal = None
    with tempfile.TemporaryDirectory(prefix="agy-space-bench-") as temporary:
        root = Path(temporary)
        cwd = root / "project"
        cwd.mkdir()
        env = harness.environment(root / "home", cwd)
        try:
            result["version"] = subprocess.check_output([str(args.binary), "--version"], env=env, text=True).strip()
            sessions = []
            for index in range(args.runs + 1):
                session_id = str(uuid.uuid4())
                source = root / f"source-{index}.jsonl"
                marker = f"RENDER_BENCH_{index:04d}"
                harness.fixture(source, cwd, session_id, marker)
                artifact = root / f"fixture-{index}.db"
                subprocess.run(["session-migrate", "convert", str(source), "--to", "antigravity",
                                "--session-id", session_id, "--cwd", str(cwd), "--output", str(artifact)],
                               env=env, cwd=cwd, stdout=subprocess.DEVNULL, check=True, timeout=30)
                # Newer converter releases publish both the SQLite picker index
                # and the protobuf summary cache used by newer native clients.
                version_check = (patch.object(antigravity, "_verified_cli", return_value=(args.binary, "1.4.12"))
                                 if hasattr(antigravity, "_verified_cli") else
                                 patch.object(antigravity, "verify_pinned_cli", return_value=args.binary))
                with version_check:
                    antigravity.install_database(artifact.read_bytes(), session_id=session_id, cwd=cwd,
                        timestamp="2026-11-23T10:00:00Z", title="Benchmark conversation",
                        target_home=root / "home" / ".gemini" / "antigravity-cli", target_cli=args.binary)
                sessions.append((session_id, marker))
            samples = []
            for index, (session_id, marker) in enumerate(sessions):
                started = time.perf_counter()
                terminal = harness.native.Terminal([str(args.binary), "--sandbox", "--conversation", session_id],
                                                   env, cwd, args.output.with_name(f"agy-terminal-{index}.log"))
                terminal.until(marker, timeout=30)
                elapsed = round((time.perf_counter() - started) * 1000, 3)
                terminal.close()
                terminal = None
                if index:
                    samples.append(elapsed)
            result.update(status="measured", samples_ms=samples, median_ms=round(statistics.median(samples), 3))
        except Exception as error:
            result["reason"] = str(error)
        finally:
            try:
                if terminal:
                    terminal.close()
            finally:
                harness.cleanup(env)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print("Antigravity Space benchmark: " + (f"{result['median_ms']:.0f} ms median" if result["status"] == "measured" else result["reason"]))
    return 0 if result["status"] == "measured" else 1


if __name__ == "__main__":
    sys.exit(main())
