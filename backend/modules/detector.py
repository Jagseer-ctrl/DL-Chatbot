"""Object detection.

Primary: YOLO (Ultralytics, PyTorch) - 80 COCO classes, runs fully offline once the
weights file is on disk.
Fallback: OpenCV HOG people detector - detects ONLY people, needs no model download.
The status endpoint reports which one is active so the UI can say so honestly.
"""
from __future__ import annotations

import importlib.util
import logging
import threading
from dataclasses import dataclass

import cv2
import numpy as np

log = logging.getLogger("vision.detector")

# COCO label -> how VISION says it out loud
FRIENDLY = {
    "cell phone": "mobile phone",
    "tv": "monitor or TV",
    "dining table": "table",
    "couch": "sofa",
    "potted plant": "plant",
    "wine glass": "glass",
    "mouse": "computer mouse",
    "remote": "remote control",
    "sports ball": "ball",
    "hair drier": "hair dryer",
    "traffic light": "traffic light",
}


def friendly(label: str) -> str:
    return FRIENDLY.get(label, label)


@dataclass
class Detection:
    label: str
    confidence: float
    box: tuple  # (x1, y1, x2, y2) in pixels of the analysed image

    def to_dict(self) -> dict:
        x1, y1, x2, y2 = self.box
        return {
            "label": self.label,
            "name": friendly(self.label),
            "confidence": round(float(self.confidence), 3),
            "box": {"x1": int(x1), "y1": int(y1), "x2": int(x2), "y2": int(y2)},
        }


class YoloDetector:
    kind = "yolo"

    def __init__(self, weights: str, conf: float, imgsz: int = 640):
        from ultralytics import YOLO  # imported lazily: heavy

        self.model = YOLO(weights)
        self.conf = conf
        self.imgsz = imgsz
        self.weights = weights

    def detect(self, bgr: np.ndarray) -> list[Detection]:
        res = self.model.predict(bgr, conf=self.conf, imgsz=self.imgsz, verbose=False)[0]
        names = res.names
        out: list[Detection] = []
        for b in res.boxes:
            x1, y1, x2, y2 = (int(v) for v in b.xyxy[0].tolist())
            out.append(Detection(names[int(b.cls[0])], float(b.conf[0]), (x1, y1, x2, y2)))
        out.sort(key=lambda d: d.confidence, reverse=True)
        return out


class HogPersonDetector:
    """People-only fallback. Its 'confidence' is a squashed SVM score, not a calibrated probability."""

    kind = "hog-person-only"
    limited = True

    def __init__(self):
        self.hog = cv2.HOGDescriptor()
        self.hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

    def detect(self, bgr: np.ndarray) -> list[Detection]:
        h, w = bgr.shape[:2]
        scale = 640 / w if w > 640 else 1.0
        img = cv2.resize(bgr, None, fx=scale, fy=scale) if scale != 1.0 else bgr
        rects, weights = self.hog.detectMultiScale(img, winStride=(8, 8), padding=(8, 8), scale=1.05)
        out: list[Detection] = []
        if len(rects) == 0:
            return out
        for (x, y, rw, rh), wt in zip(rects, np.ravel(weights)):
            conf = float(1.0 / (1.0 + np.exp(-float(wt))))
            box = tuple(int(v / scale) for v in (x, y, x + rw, y + rh))
            out.append(Detection("person", conf, box))
        out.sort(key=lambda d: d.confidence, reverse=True)
        return out


class DetectorManager:
    """Lazy, thread-safe loader so the server starts instantly."""

    def __init__(self, weights: str, conf: float, prefer_yolo: bool = True):
        self.weights, self.conf, self.prefer_yolo = weights, conf, prefer_yolo
        self._det = None
        self._error: str | None = None
        self._lock = threading.Lock()

    @classmethod
    def from_detector(cls, detector) -> "DetectorManager":
        m = cls("", 0.0, False)
        m._det = detector
        return m

    def get(self):
        with self._lock:
            if self._det is None:
                self._load()
            return self._det

    def _load(self):
        if self.prefer_yolo:
            if importlib.util.find_spec("ultralytics") is None:
                self._error = "ultralytics is not installed (pip install -r requirements-ml.txt)"
            else:
                try:
                    self._det = YoloDetector(self.weights, self.conf)
                    log.info("YOLO loaded (%s)", self.weights)
                    return
                except Exception as exc:  # weights missing + offline, corrupt file, ...
                    self._error = f"{type(exc).__name__}: {exc}"
                    log.warning("YOLO unavailable, falling back to HOG: %s", self._error)
        self._det = HogPersonDetector()

    def warmup(self):
        try:
            self.get()
        except Exception:  # pragma: no cover
            log.exception("detector warmup failed")

    def status(self) -> dict:
        det = self._det
        return {
            "loaded": det is not None,
            "backend": getattr(det, "kind", None),
            "limited": bool(getattr(det, "limited", False)),
            "yolo_installed": importlib.util.find_spec("ultralytics") is not None,
            "weights": self.weights or None,
            "error": self._error,
        }
