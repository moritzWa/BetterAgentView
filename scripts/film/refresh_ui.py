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
    # Use the actual new CmdK capture, including its live/Ready footer and
    # selected checkout row. No old status-grouped dashboard pixels remain.
    fresh = Image.open(captures / "voice-start.png").convert("RGB")
    fresh.save(captures / "voice-live.png")
    proposal = root / "proposal45"
    shutil.copyfile(captures / "session-anchors.json", proposal / "captures/session-anchors.json")
    shutil.copyfile(captures / "overview.png", proposal / "captures/overview.png")
    # Retain the original grid geometry; recompute every destination from the
    # actual new terminal rows so pane names and their landing rows agree.
    mapping = json.loads((proposal / "morph-map.json").read_text())
    scale = 1460 / 1616
    # Keep all six projects represented in the 16-pane intro, including Cronus
    # at the end of the directory-grouped list.
    omitted = {"dataset-dedup", "eval-report", "launch-demo-video", "screenshot-ocr-search"}
    panes = [a for a in anchors if a["name"] not in omitted]
    assert len(panes) == 16
    mapping["mapping"] = [
        dict(a, grid=old["grid"],
             destination=[70 + a["cell_bounds"][0] * scale,
                          200 + a["cell_bounds"][1] * scale,
                          a["cell_bounds"][2] * scale,
                          a["cell_bounds"][3] * scale],
             state_color="#df8e1d" if a["state"] == "needs_input" else "#6c6f85")
        for a, old in zip(panes, mapping["mapping"], strict=True)
    ]
    (proposal / "morph-map.json").write_text(json.dumps(mapping, indent=2))
    print("Updated 20 captured rows, voice dashboard and 16 matching intro panes; audio and native footage untouched.")


if __name__ == "__main__":
    main()
