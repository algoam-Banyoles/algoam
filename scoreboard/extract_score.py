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


_ocr_singleton = None


def _ocr():
    """RapidOCR instances cost ~1s to construct (ONNX session warm-up).
    Reuse one across calls in the same process."""
    global _ocr_singleton
    if _ocr_singleton is None:
        _ocr_singleton = RapidOCR()
    return _ocr_singleton


def _detections_to_items(result, scale=1.0, dx=0, dy=0):
    items = []
    for entry in result or []:
        bbox, text, conf = entry
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        items.append({
            "bbox": [
                int(min(xs) / scale + dx),
                int(min(ys) / scale + dy),
                int(max(xs) / scale + dx),
                int(max(ys) / scale + dy),
            ],
            "text": text,
            "conf": float(conf),
        })
    return items


def ocr_full_frame(frame_path: Path, scoreboard_box=None, scale=3):
    """Run OCR on the frame.

    If scoreboard_box=[x1,y1,x2,y2] is provided, the function crops that
    region, upscales 3x with cubic interpolation and runs OCR there: at
    720p the small single-digit scores ('0', '1') sit at the resolution
    limit and are routinely missed by RapidOCR's text detector. The 3x
    crop closes that gap. Returned bboxes are mapped back to original
    frame coordinates.
    """
    img = cv2.imread(str(frame_path))
    if img is None:
        raise RuntimeError(f"could not load {frame_path}")

    if scoreboard_box is not None:
        x1, y1, x2, y2 = scoreboard_box
        crop = img[y1:y2, x1:x2]
        if crop.size == 0:
            return []
        big = cv2.resize(crop, None, fx=scale, fy=scale,
                         interpolation=cv2.INTER_CUBIC)
        result, _ = _ocr()(big)
        return _detections_to_items(result, scale=scale, dx=x1, dy=y1)

    result, _ = _ocr()(img)
    return _detections_to_items(result)


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


_trailing_digits = re.compile(r"^(.*?)\s*(\d+)\s*$")


def split_name_and_trailing_score(raw_name, current_score):
    """Strip trailing digits off the player name.

    OCR routinely glues the score field into the name bounding box —
    "MITTERBOCK12", "JUAREZ 0", "P.BEERSMA 8" — even after we tightened
    the spatial ROIs. Billiard player surnames don't carry trailing
    numeric suffixes in practice, so we always peel them off. If the
    score ROI failed to detect anything we use the stripped digits as
    a fallback; otherwise we trust the dedicated score detection and
    just clean the name.
    """
    if not raw_name:
        return raw_name, current_score
    m = _trailing_digits.match(raw_name)
    if not m:
        return raw_name, current_score
    head, digits = m.group(1).rstrip(), int(m.group(2))
    if not head:
        return raw_name, current_score
    return head, current_score if current_score is not None else digits


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

    p1_name = join_text(p1_name_hits) or None
    p1_score = first_int(join_text(p1_score_hits))
    p1_name, p1_score = split_name_and_trailing_score(p1_name, p1_score)

    p2_name = join_text(p2_name_hits) or None
    p2_score = first_int(join_text(p2_score_hits))
    p2_name, p2_score = split_name_and_trailing_score(p2_name, p2_score)

    return {
        "modality": modality,
        "race_to": race_to,
        "innings": innings,
        "player1": {"name": p1_name, "score": p1_score},
        "player2": {"name": p2_name, "score": p2_score},
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

    items = ocr_full_frame(frame_path, scoreboard_box=LAYOUTS[layout].get("scoreboard_box"))
    payload = extract_payload(items, layout)
    payload["videoId"] = vid
    payload["layout"] = layout

    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
