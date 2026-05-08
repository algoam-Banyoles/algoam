"""
Phase 1.5: continuous local poller. For every channel with a known layout
in templates.CHANNEL_LAYOUTS, discovers the videoIds currently live, then
each POLL_INTERVAL_S grabs a frame, runs OCR, and applies the layout.

Anti-glitch: a reading is appended to out/scores.jsonl only after two
consecutive identical extractions — a single OCR slip (someone walking
through the scoreboard, replay angle) cannot pollute the log. The most
recent confirmed reading per stream is also mirrored to out/scores_latest.json
so a quick `Get-Content` shows the current state.

Discovery (which streams are live) refreshes every DISCOVERY_INTERVAL_S so
ended streams disappear and newly-live ones get picked up.

Press Ctrl+C to stop cleanly. Use --once to run a single cycle.
"""
import argparse
import json
import signal
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from grab_frame import grab_one_frame
from extract_score import ocr_full_frame, extract_payload
from templates import CHANNEL_LAYOUTS, LAYOUTS

ROOT = Path(__file__).parent
ALGOAM = ROOT.parent
OUT = ROOT / "out"
LOG = OUT / "scores.jsonl"
LATEST = OUT / "scores_latest.json"

POLL_INTERVAL_S = 10
DISCOVERY_INTERVAL_S = 300

_stop = False
def _on_sigint(_signum=None, _frame=None):
    global _stop
    _stop = True
    print("\n[stop requested, finishing current iteration]", file=sys.stderr)
signal.signal(signal.SIGINT, _on_sigint)


# ---------- Discovery (port of scripts/find_live.js) ----------

def fetch(url, timeout=15):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-US,en;q=0.9",
        "Cookie": "CONSENT=YES+1",
    })
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode("utf-8", errors="replace")


def extract_yt_initial_data(html):
    idx = html.find("ytInitialData")
    if idx < 0:
        return None
    start = html.find("{", idx)
    if start < 0:
        return None
    depth, in_str, esc = 0, False, False
    for i in range(start, len(html)):
        c = html[i]
        if esc:
            esc = False
            continue
        if in_str:
            if c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(html[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def _is_live_subtree(node):
    stack = [node]
    while stack:
        x = stack.pop()
        if isinstance(x, list):
            stack.extend(x)
            continue
        if not isinstance(x, dict):
            continue
        for k, v in x.items():
            if k == "thumbnailOverlayTimeStatusRenderer" and isinstance(v, dict) and v.get("style") == "LIVE":
                return True
            if k == "metadataBadgeRenderer" and isinstance(v, dict) and (
                v.get("label") == "LIVE NOW" or v.get("style") == "BADGE_STYLE_TYPE_LIVE_NOW"
            ):
                return True
            if k == "thumbnailBadgeViewModel" and isinstance(v, dict) and v.get("badgeStyle") == "THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE":
                return True
            if isinstance(v, (dict, list)):
                stack.append(v)
    return False


def _find_live_streams(yt_data):
    streams = []
    seen = set()

    def visit(obj):
        if isinstance(obj, list):
            for x in obj:
                visit(x)
            return
        if not isinstance(obj, dict):
            return

        old = obj.get("videoRenderer") or obj.get("gridVideoRenderer")
        if old and old.get("videoId") and old["videoId"] not in seen and _is_live_subtree(old):
            seen.add(old["videoId"])
            title = ""
            t = old.get("title") or {}
            if t.get("runs"):
                title = t["runs"][0].get("text", "")
            elif t.get("simpleText"):
                title = t["simpleText"]
            streams.append({"videoId": old["videoId"], "title": title})

        lvm = obj.get("lockupViewModel")
        if lvm and lvm.get("contentId") and lvm["contentId"] not in seen \
                and (not lvm.get("contentType") or lvm["contentType"] == "LOCKUP_CONTENT_TYPE_VIDEO") \
                and _is_live_subtree(lvm):
            seen.add(lvm["contentId"])
            title = ""
            try:
                title = lvm["metadata"]["lockupMetadataViewModel"]["title"]["content"]
            except (KeyError, TypeError):
                pass
            streams.append({"videoId": lvm["contentId"], "title": title})

        for k, v in obj.items():
            if k in ("videoRenderer", "gridVideoRenderer", "lockupViewModel"):
                continue
            visit(v)

    visit(yt_data)
    return streams


def load_channels_with_layout():
    canals = json.loads((ALGOAM / "canals.json").read_text(encoding="utf-8"))
    out = []
    for ch in canals:
        # match by handle first, then channelId — same as the JS extractor
        layout = CHANNEL_LAYOUTS.get(ch.get("handle")) or CHANNEL_LAYOUTS.get(ch.get("channelId"))
        if layout:
            out.append({**ch, "layout": layout})
    return out


def discover_lives(channels):
    out = []
    for ch in channels:
        urls = []
        if ch.get("handle"):
            urls.append(f"https://www.youtube.com/{ch['handle']}/streams")
        if ch.get("channelId"):
            urls.append(f"https://www.youtube.com/channel/{ch['channelId']}/streams")
        for u in urls:
            try:
                html = fetch(u)
                yt = extract_yt_initial_data(html)
                if not yt:
                    continue
                for s in _find_live_streams(yt):
                    out.append({
                        "videoId": s["videoId"],
                        "title": s["title"],
                        "channelKey": ch.get("handle") or ch.get("channelId"),
                        "channelName": ch.get("name"),
                        "layout": ch["layout"],
                    })
                break  # first reachable URL per channel is enough
            except Exception as e:
                print(f"  [discover fail] {u}: {e}", file=sys.stderr)
    return out


# ---------- Polling ----------

def signature(payload):
    p1 = payload.get("player1") or {}
    p2 = payload.get("player2") or {}
    return (
        payload.get("modality"), payload.get("race_to"), payload.get("innings"),
        p1.get("name"), p1.get("score"),
        p2.get("name"), p2.get("score"),
    )


def write_latest(confirmed_payloads):
    LATEST.write_text(
        json.dumps({
            "ts": datetime.now(timezone.utc).isoformat(),
            "scoreboards": list(confirmed_payloads.values()),
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def poll_one(live):
    """Capture + OCR + extract for one live. Returns payload or raises."""
    vid = live["videoId"]
    target_dir = OUT / vid
    target_dir.mkdir(parents=True, exist_ok=True)
    frame_path = target_dir / "frame.jpg"
    grab_one_frame(f"https://www.youtube.com/watch?v={vid}", frame_path)
    items = ocr_full_frame(
        frame_path,
        scoreboard_box=LAYOUTS[live["layout"]].get("scoreboard_box"),
    )
    payload = extract_payload(items, live["layout"])
    payload["videoId"] = vid
    payload["channelKey"] = live["channelKey"]
    payload["channelName"] = live["channelName"]
    payload["title"] = live["title"]
    payload["layout"] = live["layout"]
    return payload


def fmt_row(payload):
    p1 = payload.get("player1") or {}
    p2 = payload.get("player2") or {}
    name1 = (p1.get("name") or "?")[:14]
    name2 = (p2.get("name") or "?")[:14]
    s1 = p1.get("score")
    s2 = p2.get("score")
    inn = payload.get("innings")
    return (
        f"{(payload.get('channelName') or '')[:18]:18} "
        f"{name1:>14} {(s1 if s1 is not None else '-'):>3} - "
        f"{(s2 if s2 is not None else '-'):<3} {name2:<14} "
        f"(I{inn if inn is not None else '?'})"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="one cycle then exit")
    ap.add_argument("--interval", type=int, default=POLL_INTERVAL_S,
                    help=f"poll interval seconds (default {POLL_INTERVAL_S})")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    LOG.touch()

    channels = load_channels_with_layout()
    print(f"[boot] {len(channels)} channels with a known layout:")
    for c in channels:
        print(f"  - {c['name']}  ({c['layout']})")
    if not channels:
        print("Nothing to poll. Add a CHANNEL_LAYOUTS entry first.", file=sys.stderr)
        return

    lives = discover_lives(channels)
    print(f"[discovery] {len(lives)} live streams:")
    for l in lives:
        print(f"  {l['videoId']}  {l['channelName']}  -  {l['title']}")
    if not lives:
        print("No streams currently live. Will keep retrying.", file=sys.stderr)

    last_discovery = time.monotonic()
    pending = {}      # videoId -> last seen signature (not yet confirmed)
    confirmed_sig = {}      # videoId -> last confirmed signature
    confirmed_payload = {}  # videoId -> last confirmed payload

    cycle = 0
    while not _stop:
        cycle += 1
        cycle_t0 = time.monotonic()

        for live in lives:
            vid = live["videoId"]
            try:
                payload = poll_one(live)
            except Exception as e:
                print(f"  [poll fail] {vid}: {e}", file=sys.stderr)
                continue

            sig = signature(payload)
            if pending.get(vid) == sig:
                if confirmed_sig.get(vid) != sig:
                    rec = {"ts": datetime.now(timezone.utc).isoformat(), **payload}
                    with LOG.open("a", encoding="utf-8") as f:
                        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    confirmed_sig[vid] = sig
                    confirmed_payload[vid] = rec
                    print(f"[#{cycle}] {fmt_row(payload)}")
            else:
                pending[vid] = sig

        write_latest(confirmed_payload)

        if args.once:
            break

        if time.monotonic() - last_discovery > DISCOVERY_INTERVAL_S:
            lives = discover_lives(channels)
            last_discovery = time.monotonic()
            still_live = {l["videoId"] for l in lives}
            for vid in list(confirmed_payload):
                if vid not in still_live:
                    confirmed_payload.pop(vid, None)
                    confirmed_sig.pop(vid, None)
                    pending.pop(vid, None)
            print(f"[rediscovery] {len(lives)} live streams")

        # Sleep up to the next tick, but stay responsive to Ctrl+C.
        elapsed = time.monotonic() - cycle_t0
        sleep_for = max(0.0, args.interval - elapsed)
        end = time.monotonic() + sleep_for
        while not _stop and time.monotonic() < end:
            time.sleep(0.5)


if __name__ == "__main__":
    main()
