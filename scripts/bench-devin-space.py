#!/usr/bin/env python3
"""Run inside a Linux Space. Read an existing login only from streamed stdin.

The token is held in a sealed anonymous RAM file behind the native credential
path, never argv or a persistent auth file. Do not run this test on the host.
"""

import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=30)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != "Linux":
        parser.error("This test must run in the isolated Linux Space")
    login = json.load(sys.stdin)
    os.environ["PATH"] = str(Path.home() / ".local" / "bin") + ":" + os.environ.get("PATH", "")
    spec = importlib.util.spec_from_file_location("harness", Path(__file__).with_name("bench-harness-open.py"))
    harness = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(harness)
    original = harness.environment
    # Anonymous RAM-backed file, not a plaintext credential file on disk. The
    # native CLI reads its normal credential path without requiring browser auth.
    credential_fd = os.memfd_create("devin-benchmark-login", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
    credential_text = "\n".join(key + " = " + json.dumps(value) for key, value in login["credentials"].items())
    os.write(credential_fd, credential_text.encode())
    os.lseek(credential_fd, 0, os.SEEK_SET)
    os.fchmod(credential_fd, 0o400)
    fcntl.fcntl(credential_fd, fcntl.F_ADD_SEALS, fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK)
    credential_parents = []

    def environment(root, cwd):
        env = original(root, cwd)
        for parent in [root / "data" / "devin", root / ".local" / "share" / "devin"]:
            parent.mkdir(parents=True, exist_ok=True)
            (parent / "cli").mkdir(mode=0o700, exist_ok=True)
            (parent / "credentials.toml").symlink_to(f"/proc/{os.getpid()}/fd/{credential_fd}")
            parent.chmod(0o500)  # A native refresh cannot replace it with a disk file.
            credential_parents.append(parent)
        for field, variable in [("api_server_url", "WINDSURF_API_SERVER_URL"),
                                ("devin_webapp_host", "DEVIN_WEBAPP_URL"), ("devin_api_url", "DEVIN_API_URL")]:
            if login["credentials"].get(field):
                env[variable] = login["credentials"][field]
        # Account routing and completed shell onboarding contain no token.
        config = {"version": login["config"]["version"], "devin": login["config"]["devin"],
                  "shell": {"setup_complete": True}, "theme_mode": "light"}
        harness.write_json(root / "config" / "devin" / "config.json", config)
        return env

    harness.environment = environment
    try:
        with tempfile.TemporaryDirectory(prefix="devin-space-bench-") as temporary:
            root = Path(temporary)
            cwd = root / "project"
            cwd.mkdir()
            try:
                result = harness.measure("devin", str(args.binary), root / "home", cwd, args.runs,
                                         args.output.with_suffix(".diagnostics"), logs=args.output.with_suffix(".logs"))
            finally:
                for parent in credential_parents:
                    parent.chmod(0o700)
    finally:
        os.close(credential_fd)
    result.update(date=time.strftime("%Y-%m-%d"), platform=platform.platform(),
                  environment="Linux aarch64 Cua Space, 4 vCPUs, 6144 MiB, hosted on Apple M5 Pro",
                  messages_per_chat=40, terminal={"columns": 140, "rows": 40})
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print("Devin Space benchmark: " + (f"{result['median_ms']:.0f} ms median" if result["status"] == "measured" else result["reason"]))
    return 0 if result["status"] == "measured" else 1


if __name__ == "__main__":
    sys.exit(main())
