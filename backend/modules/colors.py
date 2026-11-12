"""Rough colour naming for a detected object (OpenCV, no ML).

Looks at the centre of the bounding box (to avoid background at the edges) and
names each pixel in HSV space, then reports the most common name. This is an
estimate: lighting, reflections and background bleed all affect it.
"""
from __future__ import annotations

import cv2
import numpy as np


def _name_pixels(hsv: np.ndarray) -> np.ndarray:
    h = hsv[:, 0].astype(int)
    s = hsv[:, 1].astype(int)
    v = hsv[:, 2].astype(int)
    chromatic = s >= 45
    conds = [
        v < 50,
        (s < 35) & (v > 190),
        ~chromatic,
        chromatic & ((h < 8) | (h >= 172)),
        chromatic & (h >= 8) & (h < 22) & (v < 150),
        chromatic & (h >= 8) & (h < 22),
        chromatic & (h >= 22) & (h < 35),
        chromatic & (h >= 35) & (h < 85),
        chromatic & (h >= 85) & (h < 98),
        chromatic & (h >= 98) & (h < 130),
        chromatic & (h >= 130) & (h < 150),
        chromatic & (h >= 150) & (h < 172),
    ]
    names = ["black", "white", "gray", "red", "brown", "orange", "yellow",
             "green", "teal", "blue", "purple", "pink"]
    return np.select(conds, names, default="gray")


def dominant_color(bgr: np.ndarray, box: tuple) -> dict | None:
    x1, y1, x2, y2 = box
    h, w = bgr.shape[:2]
    x1, x2 = max(0, min(w, x1)), max(0, min(w, x2))
    y1, y2 = max(0, min(h, y1)), max(0, min(h, y2))
    bw, bh = x2 - x1, y2 - y1
    if bw < 8 or bh < 8:
        return None
    mx, my = int(bw * 0.2), int(bh * 0.2)
    crop = bgr[y1 + my : y2 - my, x1 + mx : x2 - mx]
    if crop.size == 0:
        return None
    scale = 48 / max(crop.shape[:2])
    if scale < 1:
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV).reshape(-1, 3)
    names = _name_pixels(hsv)
    uniq, counts = np.unique(names, return_counts=True)
    i = int(np.argmax(counts))
    return {"name": str(uniq[i]), "share": round(float(counts[i]) / len(names), 2)}
