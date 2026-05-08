"""
End-to-end scoreboard extractor.

Given a YouTube videoId and a layout name, captures a frame near the live
edge, runs OCR over the whole frame, applies the layout's ROI template to
pick the relevant detections, normalizes them, and prints a structured
JSON payload to stdout.

Usage:
  python extract_score.py <videoId> --layout kozoom_ceb
  python extract_score.py <videoId>                    # auto-detect from
                                                       # CHANNEL_LAYOUTS
"""
import argparse
import json
import re
import sys
from pathlib import Path

import cv2
from rapidocr_onnxruntime import RapidOCR

from grab_frame import grab_one_frame
from templates import LAYOUTS

ROOT = Path(__file__).parent
OUT = ROOT / "out"


def box_center(b):
    x1, y1, x2, y2 = b
    return ((x1 + x2) // 2, (y1 + y2) // 2)


def in_roi(center, roi):
    cx, cy = center
    x1, y1, x2, y2 = roi
    return x1 <= cx <= x2 and y1 <= cy <= y2


def detections_in(items, roi):
    """Detections whose center falls inside roi, sorted left-to-right."""
    hits = []
    for it in items:
        if in_roi(box_center(it["bbox"]), roi):
            hits.append(it)
    hits.sort(key=lambda i: i["bbox"][0])
    return hits


def ocr_full_frame(frame_path: Path):
    img = cv2.imread(str(frame_path))
    if img is None:
        raise RuntimeError(f"could not load {frame_path}")
    ocr = RapidOCR()
    result, _ = ocr(img)
    items = []
    for entry in result or []:
        bbox, text, conf = entry
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        items.append({
            "bbox": [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))],
            "text": text,
            "conf": float(conf),
        })
    return items


_int_re = re.compile(r"\d+")


def first_int(s: str):
    """Return the first run of digits as int, or None."""
    m = _int_re.search(s or "")
    return int(m.group(0)) if m else None


def join_text(hits):
    return " ".join(h["text"] for h in hits).strip()


def parse_modality_race(s: str):
    """'3C[25]' -> ('3C', 25) ; 'GROUP[15]' -> ('GROUP', 15) ; '3C 25' -> ('3C', 25)."""
    s = (s or "").strip()
    m = re.match(r"([A-Za-z0-9]+)\s*[\[\(\{]?(\d+)[\]\)\}]?", s)
    if not m:
        return s or None, None
    return m.group(1), int(m.group(2))


def extract_payload(items, layout):
    rois = LAYOUTS[layout]

    mod_hits = detections_in(items, rois["modality_race"])
    innings_hits = detections_in(items, rois["innings"])
    p1_name_hits = detections_in(items, rois["p1_name"])
    p1_score_hits = detections_in(items, rois["p1_score"])
    p2_name_hits = detections_in(items, rois["p2_name"])
    p2_score_hits = detections_in(items, rois["p2_score"])

    modality, race_to = parse_modality_race(join_text(mod_hits))
    innings = first_int(join_text(innings_hits))

    return {
        "modality": modality,
        "race_to": race_to,
        "innings": innings,
        "player1": {
            "name": join_text(p1_name_hits) or None,
            "score": first_int(join_text(p1_score_hits)),
        },
        "player2": {
            "name": join_text(p2_name_hits) or None,
            "score": first_int(join_text(p2_score_hits)),
        },
    }


def channel_key_to_layout(channel_key: str):
    from templates import CHANNEL_LAYOUTS
    return CHANNEL_LAYOUTS.get(channel_key)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video", help="videoId or full URL")
    ap.add_argument("--layout", help="layout name from templates.LAYOUTS")
    ap.add_argument("--channel-key", help="auto-pick layout from this key")
    ap.add_argument("--no-grab", action="store_true",
                    help="reuse out/<videoId>/frame.jpg instead of fetching")
    args = ap.parse_args()

    layout = args.layout
    if not layout and args.channel_key:
        layout = channel_key_to_layout(args.channel_key)
    if not layout:
        sys.exit("must pass --layout or --channel-key with a known mapping")

    vid = args.video if not args.video.startswith("http") else "custom"
    target_dir = OUT / vid
    target_dir.mkdir(parents=True, exist_ok=True)
    frame_path = target_dir / "frame.jpg"

    if not args.no_grab:
        url = (args.video if args.video.startswith("http")
               else f"https://www.youtube.com/watch?v={args.video}")
        grab_one_frame(url, frame_path)

    items = ocr_full_frame(frame_path)
    payload = extract_payload(items, layout)
    payload["videoId"] = vid
    payload["layout"] = layout

    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
