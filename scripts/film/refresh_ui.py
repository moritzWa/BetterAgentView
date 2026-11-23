"""Prepare fresh UI captures for the existing edit without touching audio/native footage."""

import argparse
import json
import shutil
from pathlib import Path

from PIL import Image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    root = parser.parse_args().output
    captures = root / "captures"
    anchors = json.loads((captures / "session-anchors.json").read_text())
    assert len(anchors) == 20
    provenance = json.loads((captures / "provenance.json").read_text())
    assert provenance["synthetic_directory_count"] == 6
    # The recorded voice-live footer stays unchanged; replace the dashboard
    # above it with the new real CmdK capture, preserving selection in Film45.
    live = Image.open(captures / "voice-live.png").convert("RGB")
    fresh = Image.open(captures / "voice-start.png").convert("RGB")
    lines = (captures / "voice-start.txt").read_text().splitlines()
    footer = next(i for i, line in enumerate(lines) if "Ready." in line)
    bottom = (16 + footer * 28) * 3
    live.paste(fresh.crop((0, 0, fresh.width, bottom)), (0, 0))
    live.save(captures / "voice-live.png")
    proposal = root / "proposal45"
    shutil.copyfile(captures / "session-anchors.json", proposal / "captures/session-anchors.json")
    shutil.copyfile(captures / "overview.png", proposal / "captures/overview.png")
    # Retain the original grid geometry; recompute every destination from the
    # actual new terminal rows so pane names and their landing rows agree.
    mapping = json.loads((proposal / "morph-map.json").read_text())
    scale = 1460 / 1616
    mapping["mapping"] = [
        dict(a, grid=old["grid"],
             destination=[70 + a["cell_bounds"][0] * scale,
                          200 + a["cell_bounds"][1] * scale,
                          a["cell_bounds"][2] * scale,
                          a["cell_bounds"][3] * scale],
             state_color="#df8e1d" if a["state"] == "needs_input" else "#6c6f85")
        for a, old in zip(anchors[:16], mapping["mapping"], strict=True)
    ]
    (proposal / "morph-map.json").write_text(json.dumps(mapping, indent=2))
    print("Updated 20 captured rows, voice dashboard and 16 matching intro panes; audio and native footage untouched.")


if __name__ == "__main__":
    main()
