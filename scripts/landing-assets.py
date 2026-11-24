#!/usr/bin/env python3
"""Export public landing-page images from the reviewed synthetic film captures.

Run under heavy-job.py with uv --with pillow. No browser, playback or API calls.
"""

import argparse
import io
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--film", type=Path, required=True)
    args = parser.parse_args()
    dest = ROOT / "site/launch"
    dest.mkdir(exist_ok=True)

    def save(image, name, width=1800):
        image = image.convert("RGB")
        if image.width > width:
            image = image.resize((width, round(image.height * width / image.width)), Image.Resampling.LANCZOS)
        image.save(dest / name, "WEBP", quality=90, method=6)

    def capture(name):
        return Image.open(args.film / "captures" / f"{name}.png")

    def frame(at):
        raw = subprocess.check_output([
            "ffmpeg", "-v", "error", "-ss", str(at), "-i", str(args.film / "agentview-review.mp4"),
            "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1",
        ])
        return Image.open(io.BytesIO(raw))

    for name in ["directories", "status", "work-directories"]:
        save(capture(name), f"{name}.webp")
    # These are the actual staged dialogue cards used in the reviewed film.
    exchange = Image.new("RGB", (2480, 960), "white")
    for at, y in [(12.65, 30), (15.6, 510)]:
        card = frame(at).crop((720, 1380, 3120, 1788)).convert("RGB")
        mask = Image.new("L", card.size)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, card.width, card.height), radius=60, fill=255)
        exchange.paste(card, (40, y), mask)
    save(exchange, "voice-exchange.webp", 1400)
    save(frame(23.7).crop((230, 670, 3610, 1720)), "phone-bridge.webp", 1800)
    save(capture("continued").crop((36, 1380, 2750, 1665)), "heavy-jobs.webp", 1500)
    save(capture("scheduled").crop((36, 435, 3000, 795)), "scheduled.webp", 1500)
    save(capture("overview").crop((300, 120, 3500, 420)), "usage.webp", 1500)
    poster = frame(0).convert("RGB")
    poster.resize((1920, 1080), Image.Resampling.LANCZOS).save(ROOT / "site/film-poster.jpg", quality=92)
    frame(5.3).resize((1200, 675), Image.Resampling.LANCZOS).crop((0, 22, 1200, 652)).save(ROOT / "site/og.png")
    shutil.copyfile(args.film / "agentview-film-x.mp4", ROOT / "site/film.mp4")
    print("Exported reviewed film, poster and eight public feature visuals.")


if __name__ == "__main__":
    main()
