#!/usr/bin/env python3
"""Time actual dashboard open/detach/return separately from native CLI startup.

Requires pyte, session-migrate, and the native CLIs. Run through heavy-job.py.
Uses private homes, synthetic transcripts, no model turns, and headless PTYs.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import select
import shutil
import statistics
import tempfile
import time

import pyte


spec = importlib.util.spec_from_file_location("harness", Path(__file__).with_name("bench-harness-open.py"))
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


class ScreenTerminal(harness.native.Terminal):
    def __init__(self, *args):
        self.screen = pyte.Screen(140, 40)
        self.stream = pyte.ByteStream(self.screen)
        super().__init__(*args)

    def wait(self, predicate, timeout=45):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if select.select([self.master], [], [], 0.02)[0]:
                try:
                    chunk = os.read(self.master, 1024 * 1024)
                except OSError as error:
                    raise RuntimeError(f"PTY closed; see {self.log}") from error
                with self.log.open("ab") as log:
                    log.write(chunk)
                for query, answer in [
                    (b"\x1b[6n", b"\x1b[1;1R"),
                    (b"\x1b]11;?", b"\x1b]11;rgb:ffff/ffff/ffff\x1b\\"),
                    (b"\x1b]10;?", b"\x1b]10;rgb:0000/0000/0000\x1b\\"),
                    (b"\x1b[c", b"\x1b[?1;2c"),
                ]:
                    if query in chunk:
                        os.write(self.master, answer)
                self.stream.feed(chunk)
            visible = "\n".join(self.screen.display)
            if predicate(visible):
                return
            if self.process.poll() is not None:
                raise RuntimeError(f"Process exited: {self.process.returncode}; see {self.log}")
        raise TimeoutError(f"Screen checkpoint timed out; see {self.log}")

    def send(self, value):
        os.write(self.master, value)


PROVIDERS = ["claude", "codex", "pi", "opencode", "cursor", "copilot", "antigravity", "mistral-vibe",
             "muse", "qwen", "kimi", "omp", "grok", "kilo", "openhands", "hermes", "mastracode", "devin"]


def measure(name, binary, agentview, root, runs, cursor_auth_file, diagnostics):
    root.mkdir()
    cwd = root / "project"
    cwd.mkdir()
    home = root / "home"
    env = harness.environment(home, cwd)
    env.update(AGENTVIEW_TURN_CLASSIFIER="off", AGENTVIEW_PERF_LOG=str(root / "agentview-perf.log"), SHELL="/bin/zsh")
    terminal = None
    shell_samples = []
    try:
        if name == "cursor":
            env.pop("CURSOR_API_KEY")
            env.pop("CURSOR_API_ENDPOINT")
            env["CURSOR_AUTH_TOKEN"] = json.loads(cursor_auth_file.read_text())["cursor"]["access"]
        marker = "RENDER_BENCH_0000"
        if name == "terminal":
            (home / ".zshrc").write_text("PROMPT='RENDER_BENCH_0000> '\n")
            # Match TerminalHarness: an interactive shell with no argv flags.
            for index in range(runs + 1):
                started = time.perf_counter()
                terminal = ScreenTerminal([binary], env, cwd, root / f"shell-{index:03d}.log")
                terminal.wait(lambda screen: marker in screen)
                elapsed = (time.perf_counter() - started) * 1000
                terminal.close()
                terminal = None
                if index:
                    shell_samples.append(round(elapsed, 3))
            return {"status": "measured", "endpoint": "New interactive shell process until usable prompt",
                    "shell_startup_samples_ms": shell_samples,
                    "shell_startup_median_ms": round(statistics.median(shell_samples), 3)}
        else:
            sessions = harness.prepare(name, binary, home, cwd, env, 0)
            session_id, marker = sessions[0]
            # Warm binary caches and let Cursor publish the native history metadata
            # the real dashboard discovers. This frontend is closed, not retained.
            terminal = ScreenTerminal(harness.invocation(name, binary, session_id, cwd), env, cwd, root / "warmup.log")
            terminal.wait(lambda screen: marker in screen)
            terminal.close()
            terminal = None
        command = [str(agentview), "--theme", "light", "--include-external", "--include-interactive", "--include-temp",
                   "--cwd", str(cwd), "--launch-cwd", str(cwd), "--harness", name, "--refresh-ms", "250"]
        command += ["--no-host-" + provider for provider in PROVIDERS if provider != name]
        command += [f"--{name}-bin", binary]
        terminal = ScreenTerminal(command, env, cwd, root / "dashboard.log")
        dashboard = lambda screen: "BetterAgentView" in screen or "agentview v" in screen.lower()
        terminal.wait(dashboard)
        terminal.wait(lambda screen: dashboard(screen) and ("Imported conversation" in screen or "Explain fixture" in screen or marker in screen))
        native = lambda screen: marker in screen and not dashboard(screen)
        started = time.perf_counter()
        terminal.send(b"\r")
        terminal.wait(native)
        first_open = round((time.perf_counter() - started) * 1000, 3)
        samples = []
        for _ in range(runs):
            terminal.send(b"\x1b[25~")  # Existing F13 return-to-dashboard gesture.
            terminal.wait(dashboard)
            started = time.perf_counter()
            terminal.send(b"\r")
            terminal.wait(native)
            samples.append(round((time.perf_counter() - started) * 1000, 3))
        result = {"status": "measured", "dashboard_first_open_ms": first_open,
                  "retained_return_samples_ms": samples,
                  "retained_return_median_ms": round(statistics.median(samples), 3)}
        if shell_samples:
            result.update(shell_startup_samples_ms=shell_samples,
                          shell_startup_median_ms=round(statistics.median(shell_samples), 3))
        return result
    except Exception as error:
        result = {"status": "blocked", "reason": str(error)}
        if shell_samples:
            result.update(shell_startup_samples_ms=shell_samples,
                          shell_startup_median_ms=round(statistics.median(shell_samples), 3))
        return result
    finally:
        try:
            if terminal:
                terminal.close()
        finally:
            harness.cleanup(env)
            destination = diagnostics / name
            destination.mkdir(parents=True, exist_ok=True)
            for pattern in ["*.log", "home/.codex/log/*.log"]:
                for log in root.glob(pattern):
                    if log.is_file():
                        shutil.copyfile(log, destination / log.name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agentview", required=True, type=Path)
    parser.add_argument("--bin", required=True, action="append")
    parser.add_argument("--cursor-auth-file", type=Path)
    parser.add_argument("--runs", type=int, default=30)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be positive")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    result = {"date": time.strftime("%Y-%m-%d"), "runs": args.runs,
              "endpoint": "Dashboard Enter to retained native reply; Terminal is separately timed process-to-prompt",
              "terminal": {"columns": 140, "rows": 40}, "harnesses": {}}
    with tempfile.TemporaryDirectory(prefix="av-return-bench-") as temporary:
        root = Path(temporary).resolve()
        app = root / "agentview-test"
        shutil.copy2(args.agentview, app)
        result["agentview_sha256"] = hashlib.sha256(app.read_bytes()).hexdigest()
        for item in args.bin:
            name, binary = item.split("=", 1)
            if name not in ["codex", "cursor", "terminal"]:
                parser.error("Only codex, cursor, and terminal are supported")
            entry = measure(name, binary, app, root / name, args.runs, args.cursor_auth_file, args.output.with_suffix(".logs"))
            result["harnesses"][name] = entry
            args.output.write_text(json.dumps(result, indent=2) + "\n")
            if entry["status"] != "measured":
                summary = entry["reason"]
            elif name == "terminal":
                summary = f"{entry['shell_startup_median_ms']:.1f} ms shell startup"
            else:
                summary = f"{entry['retained_return_median_ms']:.1f} ms retained return"
            print(name + ": " + summary, flush=True)


if __name__ == "__main__":
    main()
