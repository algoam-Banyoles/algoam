"""
Per-layout scoreboard ROI templates. Each ROI is [x1, y1, x2, y2] in the
1280x720 frame; the extractor picks any OCR box whose CENTER falls inside.

Calibration of new layouts: run grab_frame.py on a live video for the
channel and read the bounding-box coordinates from the printed Top
detections list, then add a new dict here keyed by a layout name.
"""

# Kozoom Carom TV — CEB tournaments (Predator Grand Prix, etc.).
# Layout observed Nov 2026: scoreboard sits in the bottom-left of a 1280x720
# stream with two player rows and a header row.
#
#  +---------+---------+--------------+
#  | 3C[25]  |        | INNG 27       |   <- header
#  +---+-----+--------+--------+------+
#  | F | MITTERBOCK    | 8     |  ?   |   <- player1
#  +---+---------------+-------+------+
#  | F | TITZE         | 14    |  0   |   <- player2
#  +---+---------------+-------+------+
KOZOOM_CEB = {
    "modality_race": [100, 600, 175, 625],
    "innings":       [200, 600, 295, 625],
    # Names can extend almost up to the score column; the score boxes start
    # around x=247 so we cap the name ROI at 240 — anything beyond is the
    # score and would otherwise be glued to the name (e.g. "P.BEERSMA 8").
    "p1_name":       [105, 617, 240, 647],
    "p1_score":      [243, 617, 305, 647],
    "p2_name":       [105, 645, 240, 672],
    "p2_score":      [243, 645, 305, 672],
}

LAYOUTS = {
    "kozoom_ceb": KOZOOM_CEB,
}

# Map channelKey (ch.handle or ch.channelId) to a layout name. Channels
# omitted here have no scoreboard support yet.
CHANNEL_LAYOUTS = {
    "@KozoomCaromTV":  "kozoom_ceb",
    "UCOwcct1FjXWzlvmQxaR4Y8Q": "kozoom_ceb",
}
