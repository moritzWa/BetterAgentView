#!/usr/bin/env python3
"""Headless website-to-release onboarding. Use the heavy-job queue.

uv run --with playwright --with pyte python scripts/test-site-onboarding.py
  --site-dir site --output /path/to/screenshots [--install] [--audit]
Use --url https://betteragentview.com to verify the deployed site instead.
--install executes the copied Unix command only in a disposable HOME, then
checks release aliases, JSON output, the dashboard, and a first Terminal task.
Windows and Cargo commands are checked for copy fidelity, not executed.
"""

import argparse
import functools
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import uuid

from playwright.sync_api import expect, sync_playwright


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def install(command, output):
    assert command.startswith("curl -fsSL https://raw.githubusercontent.com/moritzWa/betteragentview/main/install.sh | bash")
    spec = importlib.util.spec_from_file_location("dashboard_bench", Path(__file__).with_name("bench-dashboard-return.py"))
    dashboard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dashboard)
    with tempfile.TemporaryDirectory(prefix="av-onboarding-") as temporary:
        root = Path(temporary).resolve()
        home = root / "home"
        home.mkdir()
        env = {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8",
               "TERM": "xterm-256color", "BROWSER": "/usr/bin/false", "NO_OPEN_BROWSER": "1",
               "SHELL": "/bin/zsh" if Path("/bin/zsh").exists() else "/bin/bash",
               "AGENTVIEW_TURN_CLASSIFIER": "off",
               "AV_HARNESS_BENCH_ID": uuid.uuid4().hex}
        for kind in ["CONFIG", "DATA", "STATE", "CACHE"]:
            env[f"XDG_{kind}_HOME"] = str(home / kind.lower())
        run = subprocess.run(["/bin/bash", "-c", command], env=env, cwd=root, text=True,
                             capture_output=True, timeout=180)
        (output / "installation.log").write_text(run.stdout + run.stderr)
        assert run.returncode == 0, run.stdout + run.stderr
        binary = home / ".local/bin/betteragentview"
        version = subprocess.check_output([str(binary), "--version"], env=env, text=True).strip()
        alias_versions = {"betteragentview": version}
        for alias in ["agentview", "av"]:
            reported = subprocess.check_output([str(binary.with_name(alias)), "--version"], env=env, text=True).strip()
            assert reported.split()[-1] == version.split()[-1], (alias, reported, version)
            alias_versions[alias] = reported
        snapshot = json.loads(subprocess.check_output([str(binary), "--json", "--no-host-providers"],
                                                      env=env, cwd=root, text=True, timeout=30))
        assert snapshot["sessions"] == [] and snapshot["warnings"] == [], snapshot
        (home / ".zshrc").write_text("PROMPT='ONBOARDING_READY> '\n")
        (home / ".bashrc").write_text("PS1='ONBOARDING_READY> '\n")
        terminal = dashboard.ScreenTerminal([str(binary), "--no-host-providers", "--harness", "terminal",
                                            "--launch-cwd", str(root), "--theme", "light"],
                                           env, root, output / "first-launch.log")
        try:
            terminal.wait(lambda screen: "BetterAgentView" in screen)
            terminal.send(b"First terminal\r")
            terminal.wait(lambda screen: "ONBOARDING_READY>" in screen)
            terminal.send(b"printf 'ONBOARDING_%s\\n' OK\r")
            terminal.wait(lambda screen: "ONBOARDING_OK" in screen)
            terminal.send(b"\x1b[18~")  # F7, the documented return gesture.
            terminal.wait(lambda screen: "BetterAgentView" in screen and "First terminal" in screen)
        finally:
            terminal.close()
            dashboard.harness.cleanup(env)
        return {"version": version, "aliases": alias_versions,
                "empty_json": True, "dashboard": True, "first_terminal_command": True, "return_to_dashboard": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-dir", type=Path)
    parser.add_argument("--url")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--audit", action="store_true", help="Record layout failures without stopping, for before/after evidence")
    args = parser.parse_args()
    assert bool(args.site_dir) != bool(args.url), "Choose --site-dir or --url"
    args.output.mkdir(parents=True, exist_ok=True)
    server = None
    thread = None
    if args.site_dir:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
                  functools.partial(QuietHandler, directory=str(args.site_dir.resolve())))
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
    url = args.url or f"http://127.0.0.1:{server.server_port}"
    result = {"url": url, "layouts": [], "errors": []}
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, args=["--mute-audio"])
            try:
                context = browser.new_context(permissions=["clipboard-read", "clipboard-write"], color_scheme="light")
                page = context.new_page()
                page.on("pageerror", lambda error: result["errors"].append(str(error)))
                page.route("**/*.mp4", lambda route: route.abort())
                checked_links = set()
                for width in [320, 375, 390, 640, 768, 900, 1440]:
                    page.set_viewport_size({"width": width, "height": 900})
                    response = page.goto(url, wait_until="domcontentloaded")
                    assert response.ok, response.status
                    for label in ["macOS / Linux", "Windows", "Cargo"]:
                        tab = page.get_by_role("tab", name=label, exact=True)
                        tab.click()
                        assert tab.get_attribute("aria-selected") == "true"
                        expected = tab.get_attribute("data-cmd")
                        assert page.locator("#cmd").text_content() == expected
                        page.locator("#copy").click()
                        expect(page.locator("#copy")).to_have_text("Copied")
                        assert page.evaluate("navigator.clipboard.readText()") == expected
                        metrics = page.locator("#cmd").evaluate("""el => ({
                            commandWidth: el.clientWidth, commandScrollWidth: el.scrollWidth,
                            commandHeight: el.clientHeight, boxHeight: el.offsetHeight,
                            pageWidth: document.documentElement.clientWidth,
                            pageScrollWidth: document.documentElement.scrollWidth,
                            overflowX: getComputedStyle(el).overflowX
                        })""")
                        entry = {"width": width, "tab": label, **metrics}
                        result["layouts"].append(entry)
                        page.locator(".install").screenshot(path=str(args.output / f"install-{width}-{label.split()[0]}.png"))
                        if not args.audit:
                            assert metrics["commandScrollWidth"] <= metrics["commandWidth"] + 1, entry
                            assert metrics["pageScrollWidth"] <= metrics["pageWidth"], entry
                            assert metrics["overflowX"] not in ["auto", "scroll"], entry
                    for name in ["View on GitHub", "Install guide"]:
                        href = page.get_by_role("link", name=name).get_attribute("href")
                        if href not in checked_links:
                            for _ in range(3):
                                check = context.request.get(href)
                                if check.ok or check.status not in [429, 500, 502, 503, 504]:
                                    break
                            if not check.ok:
                                result["errors"].append(f"Link returned {check.status}: {href}")
                            checked_links.add(href)
                page.get_by_role("tab", name="macOS / Linux", exact=True).click()
                page.locator("#copy").click()
                copied = page.evaluate("navigator.clipboard.readText()")
                if args.install:
                    result["installation"] = install(copied, args.output)
                if not args.audit:
                    assert not result["errors"], result["errors"]
            finally:
                browser.close()
        print(f"Onboarding: {len(result['layouts'])} layouts and clipboard checks " + ("audited" if args.audit else "passed") +
              ("; real release install, aliases, dashboard, first shell task and return passed" if args.install else ""))
    finally:
        if server:
            server.shutdown()
            server.server_close()
            thread.join()
        (args.output / "results.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
