"""Lector de marcador amb PaddleOCR (motor de reconeixement) — integrable.
Donat un fotograma, retorna JSON: {found, state, car_left, car_right, entrades,
name_left, name_right}. Localitza les caramboles per heurística (els dos números
més alts de costat amb un nom a sobre; entrades = número del mig a la mateixa
fila) sobre deteccions de PaddleOCR, molt més fiables que tesseract.

PaddleOCR llegeix bé el que tesseract.js confonia (el "7" corbat de carombooks,
multi-dígit). Funciona molt bé al layout Costa Daurada/Tarragona; el layout de
Sants (números més junts / un de no detectat) encara cal afinar-lo.

Ús (un model carregat, diversos frames):
    .venv-paddle/Scripts/python.exe scripts/paddle_scoreboard.py <img> [<img> ...]
Integració al worker Node: cridar aquest script i parsejar el JSON per línia.
"""
import os, re, sys, json
os.environ.setdefault("FLAGS_use_mkldnn", "0")  # evita un bug d'oneDNN a CPU
from paddleocr import PaddleOCR

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
    tokens = detect(img)
    # Rellotge (escalfament/pausa/mitja part): token MM:SS amb minuts <= 10.
    clock = any(re.fullmatch(r"\d{1,2}:\d{2}", t["t"]) and int(t["t"].split(":")[0]) <= 10 for t in tokens)
    loc = locate(tokens)
    if not loc:
        return {"found": False, "state": "clock" if clock else "no_scoreboard"}
    return {"found": True, "state": "clock" if clock else "ok",
            "car_left": loc["car_left"], "car_right": loc["car_right"],
            "entrades": loc["entrades"], "name_left": loc["name_left"], "name_right": loc["name_right"]}


if __name__ == "__main__":
    if "--serve" in sys.argv:
        # Mode SIDECAR persistent: el model es carrega un cop; el worker Node hi
        # envia un camí de frame per línia (stdin) i rep un JSON per línia (stdout).
        print(json.dumps({"ready": True}), flush=True)
        for line in sys.stdin:
            p = line.strip()
            if not p:
                continue
            if p == "__quit__":
                break
            try:
                r = read(p)
            except Exception as e:
                r = {"found": False, "state": "error", "error": str(e)}
            print(json.dumps(r, ensure_ascii=False), flush=True)
    else:
        for img in sys.argv[1:]:
            print(json.dumps({"img": os.path.basename(img), **read(img)}, ensure_ascii=False))
