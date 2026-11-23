#!/usr/bin/env python3
"""Small, process-free tests for native benchmark cleanup and fixtures."""

import importlib.util
import json
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


native = load("native", "bench-opencode-open.py")
harness = load("harness", "bench-harness-open.py")


class BenchmarkHelpers(unittest.TestCase):
    def process(self):
        child = Mock(pid=12345)
        child.poll.return_value = None
        return child

    def test_signal_only_a_group_still_owned_by_the_child(self):
        child = self.process()
        with patch.object(native.os, "getpgid", return_value=54321), patch.object(native.os, "killpg") as group:
            native.stop(child)
        group.assert_not_called()
        child.terminate.assert_called_once()
        child.wait.assert_called_once_with(timeout=5)

    def test_signal_own_group_and_direct_child(self):
        child = self.process()
        with patch.object(native.os, "getpgid", return_value=12345), patch.object(native.os, "killpg") as group:
            native.stop(child)
        group.assert_called_once_with(12345, signal.SIGTERM)
        child.terminate.assert_called_once()

    def test_missing_group_still_kills_direct_child_on_timeout(self):
        child = self.process()
        child.wait.side_effect = [subprocess.TimeoutExpired("fixture", 5), 0]
        with patch.object(native.os, "getpgid", side_effect=ProcessLookupError):
            native.stop(child)
        child.terminate.assert_called_once()
        child.kill.assert_called_once()

    def test_fixture_has_40_linked_messages_and_one_final_marker(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / "source.jsonl"
            harness.fixture(source, root, "fixture-session", "UNIQUE_FINAL_MARKER")
            rows = [json.loads(line) for line in source.read_text().splitlines()]
        self.assertEqual(len(rows), 40)
        self.assertIsNone(rows[0]["parentUuid"])
        for previous, row in zip(rows, rows[1:]):
            self.assertEqual(row["parentUuid"], previous["uuid"])
        self.assertTrue(rows[-1]["message"]["content"][0]["text"].endswith("UNIQUE_FINAL_MARKER"))
        self.assertEqual(json.dumps(rows).count("UNIQUE_FINAL_MARKER"), 1)

    def test_terminal_title_is_not_a_rendered_reply(self):
        self.assertEqual(native.ANSI.sub(b"", b"\x1b]0;FAKE_REPLY\x07"), b"")
        self.assertEqual(native.ANSI.sub(b"", b"\x1b[31mREAL_\x1b[0mREPLY"), b"REAL_REPLY")

    def test_devin_macos_cannot_launch_browser_onboarding(self):
        with patch.object(harness.platform, "system", return_value="Darwin"), patch.object(harness.subprocess, "Popen") as launch:
            result = harness.measure("devin", "unused", Path("unused"), Path("unused"), 30, Path("unused"))
        self.assertEqual(result["status"], "blocked")
        launch.assert_not_called()

    def test_close_drops_terminal_before_waiting_and_is_idempotent(self):
        terminal = native.Terminal.__new__(native.Terminal)
        terminal.master = 99
        terminal.process = Mock()
        events = []
        with patch.object(native.os, "close", side_effect=lambda _: events.append("terminal")), patch.object(native, "stop", side_effect=lambda _: events.append("process")):
            terminal.close()
            terminal.close()
        self.assertEqual(events, ["terminal", "process", "process"])


if __name__ == "__main__":
    unittest.main()
