#!/usr/bin/env python3
"""Measure native resume-to-transcript rendering using disposable 40-message chats.

Run through heavy-job.py --wait. Requires session-migrate on PATH. No model
prompts are submitted. HOME, agent homes, XDG state, and browser launching are
isolated. Authentication/fixture failures are recorded, never counted as timings.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import statistics
import subprocess
import tempfile
import time
import uuid

spec = importlib.util.spec_from_file_location("opencode_bench", Path(__file__).with_name("bench-opencode-open.py"))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) + "\n")


def fixture(path, cwd, session_id, marker):
    rows = []
    parent = None
    for index in range(40):
        message_id = str(uuid.uuid4())
        role = "user" if index % 2 == 0 else "assistant"
        text = (f"Explain fixture step {index // 2}." if role == "user" else
                f"Fixture step {index // 2} is complete. " + (marker if index == 39 else "No changes needed."))
        content = text if role == "user" else [{"type": "text", "text": text}]
        message = {"role": role, "content": content}
        if role == "assistant":
            message.update(id=f"msg_{index:04d}", type="message", model="claude-sonnet-4-5",
                           stop_reason="end_turn", usage={"input_tokens": 10, "output_tokens": 10})
        rows.append({"uuid": message_id, "parentUuid": parent, "sessionId": session_id,
                     "cwd": str(cwd), "timestamp": f"2026-11-23T10:00:{index:02d}.000Z",
                     "type": role, "message": message, "version": "2.1.330",
                     "isSidechain": False, "userType": "external"})
        parent = message_id
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))


def environment(root, cwd):
    # Start with an allowlist, not inherited account/plugin configuration.
    env = {key: os.environ[key] for key in ["PATH", "TMPDIR", "LANG", "LC_ALL"] if key in os.environ}
    env.update(HOME=str(root), TERM="xterm-256color", COLORTERM="truecolor",
               BROWSER="/usr/bin/false", NO_OPEN_BROWSER="1", DO_NOT_TRACK="1",
               AV_HARNESS_BENCH_ID=uuid.uuid4().hex, AGENT_CLI_CREDENTIAL_STORE="memory",
               DISABLE_AUTOUPDATER="1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
               CLAUDE_CODE_DISABLE_AUTO_MEMORY="1", CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY="1")
    for kind in ["CONFIG", "DATA", "CACHE", "STATE"]:
        path = root / kind.lower()
        path.mkdir(parents=True)
        env[f"XDG_{kind}_HOME"] = str(path)
    env.update(CLAUDE_CONFIG_DIR=str(root / ".claude"), CODEX_HOME=str(root / ".codex"),
               CURSOR_CONFIG_DIR=str(root / ".cursor"), PI_CODING_AGENT_DIR=str(root / ".pi" / "agent"),
               ANTHROPIC_API_KEY="sk-ant-local-benchmark-not-a-real-key",
               ANTHROPIC_BASE_URL="http://127.0.0.1:9",
               OPENAI_API_KEY="sk-local-benchmark-not-a-real-key",
               CURSOR_API_KEY="local-benchmark-not-a-real-key", CURSOR_API_ENDPOINT="http://127.0.0.1:9")
    settings = {"hasCompletedOnboarding": True, "theme": "light",
                "customApiKeyResponses": {"approved": [env["ANTHROPIC_API_KEY"][-20:]], "rejected": []},
                "projects": {str(cwd): {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}}}
    write_json(root / ".claude.json", settings)
    write_json(root / ".claude" / ".claude.json", settings)
    codex = root / ".codex"
    codex.mkdir()
    write_json(codex / "auth.json", {"OPENAI_API_KEY": env["OPENAI_API_KEY"]})
    (codex / "config.toml").write_text(f'[projects.{json.dumps(str(cwd))}]\ntrust_level = "trusted"\n')
    return env


def cleanup(env):
    """Reap only processes with this run's unique environment marker."""
    marker = "AV_HARNESS_BENCH_ID=" + env["AV_HARNESS_BENCH_ID"]
    def owned():
        output = subprocess.check_output(["ps", "eww", "-axo", "pid=,command="], text=True)
        return [int(line.split()[0]) for line in output.splitlines() if marker in line]
    for sig in [signal.SIGTERM, signal.SIGKILL]:
        for pid in owned():
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        time.sleep(0.2)
    remaining = owned()
    if remaining:
        raise RuntimeError(f"Benchmark processes did not stop: {remaining}")


def prepare(name, binary, root, cwd, env, runs):
    targets = {"claude": root / ".claude", "codex": root / ".codex",
               "pi": root / ".pi" / "agent", "cursor": root / ".cursor",
               "devin": root / "data" / "devin" / "cli",
               "antigravity": root / ".gemini" / "antigravity-cli"}
    sessions = []
    for index in range(runs + 1):
        session_id = str(uuid.uuid4())
        marker = f"RENDER_BENCH_{index:04d}"
        source = root / f"source-{index:04d}.jsonl"
        fixture(source, cwd, session_id, marker)
        command = ["session-migrate", "import", str(source), "--to", name,
                   "--home", str(targets[name]), "--session-id", session_id, "--cwd", str(cwd)]
        if name in ["cursor", "antigravity"]:
            # The public converter pins its installer to a different CLI build.
            # Convert a text-only database, then validate it by rendering it with
            # the actual installed CLI. Never bypass validation on a user's store.
            target = (targets[name] / "chats" / hashlib.md5(str(cwd).encode()).hexdigest() / session_id / "store.db"
                      if name == "cursor" else targets[name] / "conversations" / f"{session_id}.db")
            target.parent.mkdir(parents=True, exist_ok=True)
            command = ["session-migrate", "convert", str(source), "--to", name,
                       "--output", str(target), "--session-id", session_id, "--cwd", str(cwd)]
        result = subprocess.run(command, env=env, cwd=cwd, capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise RuntimeError("Fixture import failed: " + result.stderr.strip()[-1500:])
        if name == "pi":
            # Native resume accepts a session file. Resolve the exact imported UUID.
            candidates = list(targets[name].rglob(f"*{session_id}*.jsonl"))
            if len(candidates) != 1:
                raise RuntimeError("Pi fixture session file was not uniquely installed")
            session_id = str(candidates[0])
        sessions.append((session_id, marker))
    return sessions


def invocation(name, binary, session_id, cwd):
    if name == "claude":
        return [binary, "--resume", session_id]
    if name == "codex":
        return [binary, "resume", session_id]
    if name == "pi":
        return [binary, "--session", session_id]
    if name == "cursor":
        return [binary, "--workspace", str(cwd), "--trust", "--resume", session_id]
    if name == "devin":
        return [binary, "--respect-workspace-trust", "false", "--resume", session_id]
    return [binary, "--sandbox", "--conversation", session_id]


def measure(name, binary, root, cwd, runs, diagnostics, cursor_auth_file=None, logs=None):
    if name == "devin" and platform.system() == "Darwin":
        return {"status": "blocked", "reason": "Excluded: empty-profile Devin can enter browser sign-in on macOS despite no-browser flags; use a sandbox"}
    root.mkdir()
    env = environment(root, cwd)
    terminal = None
    try:
        if name == "cursor":
            # Read the existing login, but keep it only in the CLI's verified
            # in-memory credential backend. Never write a test token to Keychain.
            if cursor_auth_file:
                token = json.loads(cursor_auth_file.read_text())["cursor"]["access"]
            elif os.environ.get("CURSOR_AUTH_TOKEN"):
                token = os.environ["CURSOR_AUTH_TOKEN"]
            else:
                credential = subprocess.run(["/usr/bin/security", "find-generic-password", "-a", "cursor-user",
                                             "-s", "cursor-access-token", "-w"], capture_output=True, text=True, timeout=15)
                if credential.returncode:
                    raise RuntimeError("Existing Cursor login could not be read")
                token = credential.stdout.strip()
            env.pop("CURSOR_API_KEY")
            env.pop("CURSOR_API_ENDPOINT")
            env["CURSOR_AUTH_TOKEN"] = token
        version = subprocess.run([binary, "--version"], env=env, capture_output=True, text=True, timeout=20)
        if version.returncode:
            raise RuntimeError("Version probe failed: " + version.stderr[-1000:])
        sessions = prepare(name, binary, root, cwd, env, runs)
        samples = []
        for index, (session_id, marker) in enumerate(sessions):
            started = time.perf_counter()
            terminal = native.Terminal(invocation(name, binary, session_id, cwd), env, cwd,
                                       root / f"terminal-{index:04d}.log")
            terminal.until(marker, timeout=30)
            elapsed = round((time.perf_counter() - started) * 1000, 3)
            terminal.close()
            terminal = None
            if index:  # Warm one process and native history before measuring.
                samples.append(elapsed)
        if logs:
            destination = logs / name
            destination.mkdir(parents=True, exist_ok=True)
            for log in root.glob("terminal-*.log"):
                shutil.copyfile(log, destination / log.name)
        return {"status": "measured", "version": version.stdout.strip(), "samples_ms": samples,
                "median_ms": round(statistics.median(samples), 3),
                "path": invocation(name, Path(binary).name, "<session-id>", Path("<project>"))}
    except Exception as error:
        destination = diagnostics / name
        # Keep only terminal output, not profiles that a CLI could populate with
        # credentials during unexpected onboarding.
        destination.mkdir(parents=True, exist_ok=True)
        for log in root.glob("terminal-*.log"):
            shutil.copyfile(log, destination / log.name)
        return {"status": "blocked", "reason": str(error), "diagnostics": str(destination)}
    finally:
        try:
            if terminal:
                terminal.close()
        finally:
            cleanup(env)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin", action="append", required=True, help="harness=/absolute/path/to/cli")
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--cursor-auth-file", type=Path, help="Read an existing OpenCode Cursor login; never modify it")
    parser.add_argument("--logs", type=Path, help="Keep synthetic terminal logs for startup-warning checks")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("runs must be positive")
    result = {"date": time.strftime("%Y-%m-%d"), "platform": platform.platform(),
              "runs_per_harness": args.runs, "messages_per_chat": 40,
              "terminal": {"rows": 40, "columns": 140},
              "operation": "New native process resuming an existing synthetic chat; final reply reaches PTY",
              "excludes": "Dashboard, model requests, first-run onboarding, retained-TUI revisits",
              "harnesses": {}}
    if platform.system() == "Darwin":
        result["cpu"] = subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip()
    diagnostics = args.output.with_suffix(".diagnostics")
    with tempfile.TemporaryDirectory(prefix="av-harness-bench-") as temporary:
        root = Path(temporary).resolve()
        cwd = root / "project"
        cwd.mkdir()
        for item in args.bin:
            name, binary = item.split("=", 1)
            if name not in ["claude", "codex", "pi", "cursor", "devin", "antigravity"]:
                parser.error(f"Unsupported harness: {name}")
            binary = shutil.which(binary) or str(Path(binary).resolve())
            entry = measure(name, binary, root / name, cwd, args.runs, diagnostics, args.cursor_auth_file, args.logs)
            result["harnesses"][name] = entry
            args.output.write_text(json.dumps(result, indent=2) + "\n")
            summary = f"{entry['median_ms']:.0f} ms median" if entry["status"] == "measured" else entry["reason"]
            print(f"{name}: {summary}", flush=True)


if __name__ == "__main__":
    main()
