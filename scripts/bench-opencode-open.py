#!/usr/bin/env python3
"""Compare stock/fork native chat rendering without touching a user's service.

Run through heavy-job.py --wait. Uses disposable HOME/XDG directories, imported
synthetic transcripts, an already-running private server, and headless PTYs.
No prompts are sent to a model. Times end when the final reply's marker is
written to the terminal, not when the server merely accepts a switch request.
"""

import argparse
import base64
import fcntl
import json
import os
from pathlib import Path
import platform
import pty
import re
import select
import signal
import socket
import statistics
import struct
import subprocess
import tempfile
import termios
import time
import urllib.error
import urllib.request


PASSWORD = "disposable-benchmark-service"
ANSI = re.compile(rb"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]")


def stop(process):
    if process.poll() is None:
        try:
            if os.getpgid(process.pid) == process.pid:
                os.killpg(process.pid, signal.SIGTERM)
        except (PermissionError, ProcessLookupError):
            pass
        # Native CLIs can change process groups after launch. Always signal the
        # direct child as well, rather than assuming its original group exists.
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                if os.getpgid(process.pid) == process.pid:
                    os.killpg(process.pid, signal.SIGKILL)
            except (PermissionError, ProcessLookupError):
                pass
            process.kill()
            process.wait(timeout=5)


class Terminal:
    def __init__(self, command, env, cwd, log):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
        self.log = log
        self.process = subprocess.Popen(
            command, env=env, cwd=cwd, stdin=slave, stdout=slave, stderr=slave,
            start_new_session=True,
        )
        os.close(slave)

    def until(self, marker, timeout=30):
        deadline = time.monotonic() + timeout
        output = b""
        while time.monotonic() < deadline:
            if not select.select([self.master], [], [], 0.05)[0]:
                if self.process.poll() is not None:
                    raise RuntimeError(f"TUI exited: {self.process.returncode}; see {self.log}")
                continue
            try:
                chunk = os.read(self.master, 1024 * 1024)
            except OSError as error:
                raise RuntimeError(f"TUI closed; see {self.log}") from error
            with self.log.open("ab") as log:
                log.write(chunk)
            output = (output + chunk)[-2_000_000:]
            # Answer terminal probes without opening a real terminal window.
            for query, answer in [
                (b"\x1b[c", b"\x1b[?1;2c"),
                (b"\x1b[>c", b"\x1b[>1;4000;0c"),
                (b"\x1b[6n", b"\x1b[1;1R"),
                (b"\x1b]11;?", b"\x1b]11;rgb:ffff/ffff/ffff\x1b\\"),
                (b"\x1b]10;?", b"\x1b]10;rgb:0000/0000/0000\x1b\\"),
            ]:
                if query in chunk:
                    os.write(self.master, answer)
            if marker.encode() in ANSI.sub(b"", output):
                return
        raise TimeoutError(f"No rendered marker {marker}; see {self.log}")

    def close(self):
        # Drop the terminal first so a CLI's shutdown cannot block on a full
        # output buffer while this thread waits for it to exit.
        if self.master is not None:
            os.close(self.master)
            self.master = None
        stop(self.process)


class Server:
    def __init__(self, binary, root, cwd):
        self.binary = str(Path(binary).resolve())
        self.root = root
        self.cwd = cwd
        self.env = {k: v for k, v in os.environ.items() if not k.startswith((
            "OPENCODE_", "XDG_", "CURSOR_", "ANTHROPIC_", "OPENAI_", "OPENROUTER_",
        ))}
        self.env.update(HOME=str(root), TERM="xterm-256color", COLORTERM="truecolor",
                        OPENCODE_PASSWORD=PASSWORD, OPENCODE_DISABLE_AUTOUPDATE="1")
        for name in ["CONFIG", "DATA", "CACHE", "STATE"]:
            path = root / name.lower()
            path.mkdir(parents=True)
            self.env[f"XDG_{name}_HOME"] = str(path)
        self.env["OPENCODE_CONFIG_DIR"] = str(root / "config" / "opencode")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        self.version = subprocess.check_output([self.binary, "--version"], env=self.env, text=True).strip()
        self.log = (root / "server.log").open("w")
        self.process = subprocess.Popen(
            [self.binary, "serve", "--hostname", "127.0.0.1", "--port", str(port)],
            env=self.env, cwd=cwd, stdout=self.log, stderr=self.log, start_new_session=True,
        )

    def request(self, path, body=None):
        request = urllib.request.Request(self.url + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Basic " +
                     base64.b64encode(f"opencode:{PASSWORD}".encode()).decode()})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"{path}: {error.code}: {error.read().decode()}") from error

    def ready(self):
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(f"Service exited; see {self.root / 'server.log'}")
            try:
                self.info = self.request("/api/info")
                return
            except (OSError, RuntimeError):
                time.sleep(0.1)
        raise TimeoutError(f"Service not ready; see {self.root / 'server.log'}")

    def seed(self, runs, messages):
        template = self.request("/api/session", {"title": "Benchmark template",
                                               "location": {"directory": str(self.cwd)}})["data"]
        for index in range(runs + 1):
            info = dict(template, id=f"ses_benchmark{index:04d}", title=f"Benchmark chat {index:04d}")
            transcript = []
            for turn in range(messages // 2):
                created = 1_790_000_000_000 + turn * 1000
                transcript.extend([
                    {"id": f"msg_bench{index:04d}u{turn:04d}", "type": "user",
                     "time": {"created": created}, "text": f"Explain fixture step {turn}.",
                     "files": [], "agents": [], "skills": []},
                    {"id": f"msg_bench{index:04d}a{turn:04d}", "type": "assistant",
                     "time": {"created": created + 1, "completed": created + 2},
                     "agent": "build", "model": {"providerID": "opencode", "id": "big-pickle"},
                     "finish": "stop", "content": [{"type": "text", "text":
                         f"Fixture step {turn} is complete. " +
                         (f"RENDER_BENCH_{index:04d}" if turn == messages // 2 - 1 else "No changes needed.")}]},
                ])
            self.request("/api/experimental/session/import", {"info": info, "messages": transcript,
                                                            "location": {"directory": str(self.cwd)}})

    def terminal(self, index, client=None):
        env = dict(self.env)
        if client:
            env["OPENCODE_TUI_CLIENT_ID"] = client
        return Terminal([self.binary, "--server", self.url, str(self.cwd),
                         "--session", f"ses_benchmark{index:04d}"], env, self.cwd,
                        self.root / f"terminal-{index:04d}.log")

    def close(self):
        stop(self.process)
        self.log.close()


def measure(binary, root, cwd, runs, messages, shared):
    root.mkdir()
    server = Server(binary, root, cwd)
    terminal = None
    try:
        server.ready()
        server.seed(runs, messages)
        has_switch = server.info.get("capabilities", {}).get("tuiSessionSelect", False)
        if shared and not has_switch:
            raise RuntimeError("Fork does not advertise targeted TUI switching")
        # Both cases warm one initial chat and the server before measuring.
        terminal = server.terminal(0, "benchmark-shared" if shared else None)
        terminal.until("RENDER_BENCH_0000")
        if not shared:
            terminal.close()
            terminal = None
        samples = []
        for index in range(1, runs + 1):
            started = time.perf_counter()
            if shared:
                server.request("/api/tui/select-session", {
                    "sessionID": f"ses_benchmark{index:04d}", "client": "benchmark-shared",
                    "targetDirectory": str(cwd),
                })
            else:
                terminal = server.terminal(index)
            terminal.until(f"RENDER_BENCH_{index:04d}")
            samples.append(round((time.perf_counter() - started) * 1000, 3))
            if not shared:
                terminal.close()
                terminal = None
        return {"binary": Path(server.binary).name, "version": server.version,
                "targeted_switch": has_switch, "samples_ms": samples,
                "median_ms": round(statistics.median(samples), 3)}
    finally:
        if terminal:
            terminal.close()
        server.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stock", required=True)
    parser.add_argument("--fork", required=True)
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--messages", type=int, default=40)
    parser.add_argument("--order", choices=["stock-first", "fork-first"], default="stock-first")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.runs < 1 or args.messages < 2 or args.messages % 2:
        parser.error("runs must be positive; messages must be positive, even, and at least 2")
    result = {"date": time.strftime("%Y-%m-%d"), "platform": platform.platform(),
              "runs": args.runs, "messages_per_chat": args.messages,
              "terminal": {"rows": 40, "columns": 140},
              "operation": "First visit to another chat, server warm; final reply rendered",
              "includes": "TUI launch or targeted switch plus transcript render; no model request",
              "excludes": "Dashboard dispatch/preview, server startup, and revisits to retained TUIs"}
    if platform.system() == "Darwin":
        result["cpu"] = subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip()
    result["order"] = ["stock", "fork"] if args.order == "stock-first" else ["fork", "stock"]
    with tempfile.TemporaryDirectory(prefix="av-opencode-bench-") as temporary:
        root = Path(temporary)
        cwd = root / "project"
        cwd.mkdir()
        try:
            for name in result["order"]:
                result[name] = measure(getattr(args, name), root / name, cwd,
                                       args.runs, args.messages, name == "fork")
                print(f"{name}: {result[name]['median_ms']:.0f} ms median", flush=True)
        except Exception:
            # Retain diagnostics on failure, not any user's config or credentials.
            import shutil
            shutil.copytree(root, args.output.with_suffix(".diagnostics"), dirs_exist_ok=True)
            raise
    args.output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
