"""Llegeix amb PaddleOCR 3.x i imprimeix deteccions (text, conf, posició) de cada
imatge. Per provar el reconeixement dels marcadors carombooks.
    .venv-paddle/Scripts/python.exe scripts/paddle_read.py <img> [<img> ...]
"""
import sys, json, os
os.environ.setdefault("FLAGS_use_mkldnn", "0")
from paddleocr import PaddleOCR

try:
    ocr = PaddleOCR(lang="en", use_textline_orientation=False, enable_mkldnn=False)
except TypeError:
    ocr = PaddleOCR(lang="en", use_textline_orientation=False)


def run(img):
    out = []
    try:
        res = ocr.predict(img)
    except Exception:
        return out
    for r in res:
        try:
            texts = r["rec_texts"]
            scores = r["rec_scores"]
            polys = r.get("rec_polys")
            if polys is None or len(polys) == 0:
                polys = r.get("dt_polys")
        except Exception:
            continue
        for txt, conf, box in zip(texts, scores, polys):
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            out.append({"t": txt, "conf": round(float(conf), 2),
                        "cx": round(sum(xs) / len(xs)), "cy": round(sum(ys) / len(ys)),
                        "h": round(max(ys) - min(ys))})
    return out


for img in sys.argv[1:]:
    print(os.path.basename(img), json.dumps(run(img), ensure_ascii=False))
