"""
Phase 1 POC: capture one frame from a live YouTube video and run OCR over
the whole frame. Output goes to scoreboard/out/<videoId>/:
  frame.jpg       — raw 720p frame
  ocr.json        — list of {bbox, text, conf} from rapidocr
  ocr_overlay.jpg — frame with bounding boxes drawn for visual inspection

Once this works we use ocr_overlay.jpg to pick the bounding boxes for the
scoreboard fields (player names, scores, innings) and codify them as a
per-channel template.

Usage:
  python grab_frame.py <videoId>            # default to KOZOOM table
  python grab_frame.py --url <full URL>
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

ROOT = Path(__file__).parent
OUT = ROOT / "out"


def find(cmd: str) -> str:
    found = shutil.which(cmd)
    if not found:
        sys.exit(f"required tool not found in PATH: {cmd}")
    return found


YTDLP = find("yt-dlp")
FFMPEG = find("ffmpeg")


def grab_one_frame(video_url: str, dest: Path) -> None:
    """Pull a 720p frame near the live edge using yt-dlp + ffmpeg.

    -f selects 720p mp4 if available; falls back to best <=720p.
    --live-from-start would replay from the beginning, we want the now —
    so we use ffmpeg's input flag to seek 0s into whatever yt-dlp serves.
    """
    # Resolve the direct media URL via yt-dlp -g (gets the playable URL).
    # For a live HLS stream this returns the manifest URL.
    proc = subprocess.run(
        [YTDLP, "-f", "best[height<=720]/best", "-g", video_url],
        capture_output=True, text=True, check=True,
    )
    direct = proc.stdout.strip().splitlines()[-1]
    if not direct:
        raise RuntimeError("yt-dlp -g returned no URL")

    # ffmpeg: take exactly one frame from the most recent segment.
    # -live_start_index -1 starts at the latest segment (HLS), -t 0.1
    # bounds reads, -frames:v 1 dumps a single frame, -y overwrites.
    subprocess.run(
        [
            FFMPEG, "-hide_banner", "-loglevel", "error",
            "-live_start_index", "-1",
            "-i", direct,
            "-frames:v", "1",
            "-y", str(dest),
        ],
        check=True,
    )


def run_ocr(frame_path: Path):
    ocr = RapidOCR()
    img = cv2.imread(str(frame_path))
    if img is None:
        raise RuntimeError(f"could not load {frame_path}")
    result, _elapsed = ocr(img)
    items = []
    for entry in result or []:
        bbox, text, conf = entry
        # bbox is 4 (x,y) corners — store as [x1,y1,x2,y2] for ease.
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        items.append({
            "bbox": [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))],
            "text": text,
            "conf": float(conf),
        })
    return img, items


def draw_overlay(img: np.ndarray, items, dest: Path):
    out = img.copy()
    for it in items:
        x1, y1, x2, y2 = it["bbox"]
        cv2.rectangle(out, (x1, y1), (x2, y2), (0, 255, 0), 2)
        label = f'{it["text"]} ({it["conf"]:.2f})'
        cv2.putText(out, label, (x1, max(0, y1 - 4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1, cv2.LINE_AA)
    cv2.imwrite(str(dest), out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video", nargs="?", help="videoId or full YouTube URL")
    ap.add_argument("--url", help="override with a full URL")
    args = ap.parse_args()

    if args.url:
        url = args.url
        vid = "custom"
    else:
        if not args.video:
            sys.exit("usage: grab_frame.py <videoId>")
        vid = args.video
        url = (vid if vid.startswith("http")
               else f"https://www.youtube.com/watch?v={vid}")

    target_dir = OUT / vid
    target_dir.mkdir(parents=True, exist_ok=True)
    frame_path = target_dir / "frame.jpg"

    print(f"[1/3] Grabbing live frame from {url}")
    grab_one_frame(url, frame_path)
    print(f"      -> {frame_path}  ({frame_path.stat().st_size // 1024} KB)")

    print("[2/3] Running OCR")
    img, items = run_ocr(frame_path)
    print(f"      -> {len(items)} text boxes detected")

    json_path = target_dir / "ocr.json"
    json_path.write_text(json.dumps(items, ensure_ascii=False, indent=2),
                         encoding="utf-8")
    overlay = target_dir / "ocr_overlay.jpg"
    draw_overlay(img, items, overlay)
    print(f"[3/3] Wrote {json_path.name} + {overlay.name}")

    # Print the strongest detections to console for a quick sanity check.
    items_sorted = sorted(items, key=lambda i: -i["conf"])
    print("\nTop detections:")
    for it in items_sorted[:20]:
        print(f"  {it['conf']:.2f}  {it['bbox']}  {it['text']!r}")


if __name__ == "__main__":
    main()
