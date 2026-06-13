"""Benchmark d'un lector de marcador basat en PaddleOCR contra la veritat de
terreny (train/labels.json + train/vod_labels.json). Localitza les caramboles
amb la mateixa heurística (els dos números més alts de costat amb un nom a
sobre; entrades = número del mig a la mateixa fila) però sobre deteccions de
PaddleOCR, molt més fiables que tesseract.
    .venv-paddle/Scripts/python.exe scripts/paddle_bench.py
"""
import os, re, json, subprocess, tempfile, unicodedata
os.environ.setdefault("FLAGS_use_mkldnn", "0")
from paddleocr import PaddleOCR

ROOT = os.path.join(os.path.dirname(__file__), "..", "train")
try:
    OCR = PaddleOCR(lang="en", use_textline_orientation=False, enable_mkldnn=False)
except TypeError:
    OCR = PaddleOCR(lang="en", use_textline_orientation=False)


def detect(img):
    try:
        res = OCR.predict(img)
    except Exception:
        return []
    out = []
    for r in res:
        try:
            texts, scores = r["rec_texts"], r["rec_scores"]
            polys = r.get("rec_polys")
            if polys is None or len(polys) == 0:
                polys = r.get("dt_polys")
        except Exception:
            continue
        for t, c, box in zip(texts, scores, polys):
            xs = [float(p[0]) for p in box]; ys = [float(p[1]) for p in box]
            out.append({"t": t.strip(), "conf": float(c), "cx": sum(xs) / len(xs),
                        "cy": sum(ys) / len(ys), "h": max(ys) - min(ys)})
    return out


def locate(tokens):
    nums = [x for x in tokens if re.fullmatch(r"\d{1,3}", x["t"]) and x["h"] >= 8]
    names = [x for x in tokens if re.search(r"[A-Za-zÀ-ÿ]{3,}", x["t"]) and x["h"] >= 6]
    if len(nums) < 2:
        return None
    nums.sort(key=lambda x: -x["h"])
    best = None
    for i, big in enumerate(nums):
        for j, partner in enumerate(nums):
            if j == i:
                continue
            if (abs(partner["cy"] - big["cy"]) < big["h"] * 0.5
                    and abs(partner["h"] - big["h"]) < big["h"] * 0.45
                    and abs(partner["cx"] - big["cx"]) > big["h"] * 0.8):
                left, right = (big, partner) if big["cx"] <= partner["cx"] else (partner, big)
                name_above = any(t["cy"] < min(left["cy"], right["cy"])
                                 and left["cx"] - left["h"] < t["cx"] < right["cx"] + right["h"] for t in names)
                score = (left["h"] + right["h"]) * (1.6 if name_above else 1)
                if best and score <= best["score"]:
                    continue
                midY = (left["cy"] + right["cy"]) / 2
                minH = min(left["h"], right["h"])
                ent = [n for n in nums if n is not left and n is not right
                       and left["cx"] < n["cx"] < right["cx"] and abs(n["cy"] - midY) < minH * 0.9]
                ent.sort(key=lambda n: abs(n["cy"] - midY))

                def near(col, other):
                    cand = [t for t in names if t["cy"] < col["cy"]
                            and abs(t["cx"] - col["cx"]) < col["h"] * 2.2
                            and abs(t["cx"] - col["cx"]) <= abs(t["cx"] - other["cx"])]
                    cand.sort(key=lambda t: -t["cy"])
                    return cand[0]["t"] if cand else None
                best = {"score": score, "car_left": int(left["t"]), "car_right": int(right["t"]),
                        "entrades": int(ent[0]["t"]) if ent else None,
                        "name_left": near(left, right), "name_right": near(right, left)}
    return best


def read(img):
    return locate(detect(img))


def norm(s):
    if not s:
        return ""
    s = unicodedata.normalize("NFD", s)
    return "".join(c for c in s if c.isalpha()).upper()


def main():
    labels = json.load(open(os.path.join(ROOT, "labels.json"), encoding="utf8"))
    cases = []  # (img_path_or_vodkey, gt, is_vod)
    for k, t in labels.items():
        if t.get("no_scoreboard"):
            continue
        cases.append((os.path.join(ROOT, "frames", k + ".png"), t, None))
    vodf = os.path.join(ROOT, "vod", "match.mp4")
    vlab = json.load(open(os.path.join(ROOT, "vod_labels.json"), encoding="utf8"))
    for k, t in vlab.items():
        if t.get("no_scoreboard"):
            continue
        cases.append((vodf, t, t["t_clip"]))

    car = ent = side = tot = 0
    fails = []
    tmp = tempfile.mkdtemp()
    for src, t, tclip in cases:
        img = src
        if tclip is not None:
            img = os.path.join(tmp, "f.png")
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(tclip), "-i", src,
                            "-frames:v", "1", "-q:v", "2", img], timeout=30)
        r = read(img)
        tot += 1
        gtA, gtB = str(t["car_left"]), str(t["car_right"])
        gtE = str(t["entrades"]) if t["entrades"] != "" else None
        cok = r and str(r["car_left"]) == gtA and str(r["car_right"]) == gtB
        eok = r and (gtE is None or str(r["entrades"]) == gtE)
        if cok:
            car += 1
        if eok:
            ent += 1
        if r and t.get("name_left") and t.get("name_right"):
            nl, nr, tl, tr = norm(r["name_left"]), norm(r["name_right"]), norm(t["name_left"]), norm(t["name_right"])
            if (tl and (tl in nl or nl in tl)) or (tr and (tr in nr or nr in tr)):
                side += 1
        if not cok:
            tag = os.path.basename(src) + (f"@{tclip}" if tclip is not None else "")
            fails.append(f"{tag}: OCR {r and (str(r['car_left'])+'-'+str(r['car_right'])+'/e'+str(r['entrades'])) or 'None'} | cal {gtA}-{gtB}/e{gtE}")
    print(f"PaddleOCR → CARAMBOLES {car}/{tot}  ENTRADES {ent}/{tot}  COSTAT {side}/{tot}")
    for f in fails:
        print("  " + f)


if __name__ == "__main__":
    main()
