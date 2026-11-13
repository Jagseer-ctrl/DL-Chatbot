"""VISION backend - one Flask app used by BOTH the Electron desktop shell and the web deployment.

Endpoints
  GET  /vision/status        capabilities of this backend (detector, STT/TTS, LLM, RAG)
  POST /voice/transcribe     multipart: audio (+ language)         -> {text, language, engine}
  POST /voice/speak          json: {text, speed?, language?}       -> audio/wav (501 => use browser TTS)
  POST /vision/detect        image (multipart "image" or json data-URL) -> boxes
  POST /vision/analyze       image -> boxes + positions + colours + spoken summary
  POST /vision/ask           image + question (+history, language) -> answer about the camera frame
  POST /vision/classify      image (+optional box) -> CIFAR-10 CNN top-3 (educational)
  POST /chat                 {message, history?, language?}        -> text-only answer

Privacy: images and audio are processed in memory and never written to disk or logged.
"""
from __future__ import annotations

import base64
import binascii
import logging
import re
import threading
import time
from collections import defaultdict, deque
from pathlib import Path

import cv2
import numpy as np
from flask import Flask, Response, jsonify, request, send_from_directory

from config import Config
from modules import edu_models, llm, vqa, voice
from modules.chat import Assistant
from modules.colors import dominant_color
from modules.detector import DetectorManager

VERSION = "2.0.0"
LANGS = {"en", "hi", "pa"}
MAX_SIDE = 1280
PUBLIC_PATHS = {"/vision/status", "/health"}
API_PREFIXES = ("/vision/", "/voice/", "/chat", "/api/")

log = logging.getLogger("vision")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra


def create_app(config: Config | None = None, detector=None, assistant: Assistant | None = None, warmup: bool = False) -> Flask:
    cfg = config or Config.from_env()
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = cfg.max_upload_mb * 1024 * 1024
    app.json.sort_keys = False

    if cfg.trust_proxy:
        from werkzeug.middleware.proxy_fix import ProxyFix

        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    manager = DetectorManager.from_detector(detector) if detector is not None else DetectorManager(
        cfg.yolo_weights, cfg.confidence, cfg.prefer_yolo
    )
    bot = assistant or Assistant(cfg)
    if warmup and detector is None:
        threading.Thread(target=manager.warmup, daemon=True).start()

    # ------------------------------------------------------------------ guards
    hits: dict[str, deque] = defaultdict(deque)
    hits_lock = threading.Lock()

    def is_api(path: str) -> bool:
        return path.startswith(API_PREFIXES) or path == "/health"

    def is_origin_allowed(orig: str) -> bool:
        if not orig:
            return False
        if "*" in cfg.cors_origins or orig in cfg.cors_origins:
            return True
        if orig.startswith("http://localhost:") or orig.startswith("http://127.0.0.1:"):
            return True
        if orig.endswith(".vercel.app") or ".onrender.com" in orig:
            return True
        return False

    @app.before_request
    def guard():
        if request.method == "OPTIONS":
            resp = Response(status=204)
            origin = request.headers.get("Origin")
            if is_origin_allowed(origin):
                resp.headers["Access-Control-Allow-Origin"] = origin
                resp.headers["Vary"] = "Origin"
                resp.headers["Access-Control-Allow-Headers"] = request.headers.get("Access-Control-Request-Headers", "Content-Type, Authorization")
                resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
                resp.headers["Access-Control-Max-Age"] = "86400"
            return resp
        if not is_api(request.path):
            return None
        if cfg.api_token and request.path not in PUBLIC_PATHS:
            auth = request.headers.get("Authorization", "")
            if auth != f"Bearer {cfg.api_token}":
                raise ApiError(401, "unauthorized", "Missing or invalid API token.")
        if cfg.rate_limit_per_min > 0 and request.path not in PUBLIC_PATHS:
            now = time.monotonic()
            with hits_lock:
                q = hits[request.remote_addr or "?"]
                while q and now - q[0] > 60:
                    q.popleft()
                if len(q) >= cfg.rate_limit_per_min:
                    raise ApiError(429, "rate_limited", "Too many requests. Please slow down.")
                q.append(now)
        return None

    @app.after_request
    def headers(resp: Response):
        origin = request.headers.get("Origin")
        if is_origin_allowed(origin):
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Vary"] = "Origin"
            resp.headers["Access-Control-Allow-Headers"] = request.headers.get("Access-Control-Request-Headers", "Content-Type, Authorization")
            resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            resp.headers["Access-Control-Max-Age"] = "86400"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["Permissions-Policy"] = "camera=(self), microphone=(self), geolocation=()"
        if is_api(request.path):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.errorhandler(ApiError)
    def api_error(e: ApiError):
        return jsonify({"error": {"code": e.code, "message": e.message, **e.extra}}), e.status

    @app.errorhandler(413)
    def too_large(_):
        return jsonify({"error": {"code": "too_large", "message": f"Upload exceeds {cfg.max_upload_mb} MB."}}), 413

    @app.errorhandler(404)
    def not_found(_):
        return jsonify({"error": {"code": "not_found", "message": "Not found."}}), 404

    @app.errorhandler(llm.LLMError)
    def llm_unavailable(e):
        return jsonify({"error": {
            "code": "llm_unavailable",
            "message": str(e) or "The AI model could not complete this request. Check your GEMINI_API_KEY and model configuration.",
        }}), 502

    @app.errorhandler(Exception)
    def unexpected(e):
        if hasattr(e, "code") and isinstance(e.code, int):  # werkzeug HTTPException
            return jsonify({"error": {"code": "http_error", "message": getattr(e, "description", "Error")}}), e.code
        log.exception("unhandled error")  # no request bodies are logged
        return jsonify({"error": {"code": "internal_error", "message": "Something went wrong on the server."}}), 500

    # ------------------------------------------------------------------ helpers
    def payload() -> dict:
        data = request.get_json(silent=True)
        merged = dict(request.form) if request.form else {}
        if isinstance(data, dict):
            merged.update(data)
        return merged

    def read_image(required: bool = True):
        raw = None
        f = request.files.get("image")
        if f is not None:
            raw = f.read()
        else:
            s = payload().get("image")
            if s is None:
                if required:
                    raise ApiError(400, "missing_image", "Send an image as multipart field 'image' or a base64 data-URL in JSON.")
                return None
            if not isinstance(s, str) or not s:
                raise ApiError(400, "invalid_image", "'image' must be a non-empty base64 string.")
            if s.startswith("data:"):
                s = s.split(",", 1)[1] if "," in s else ""
            try:
                raw = base64.b64decode(s, validate=True)
            except (binascii.Error, ValueError):
                raise ApiError(400, "invalid_image", "'image' is not valid base64.")
        if not raw:
            raise ApiError(400, "invalid_image", "The image is empty.")
        img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise ApiError(400, "invalid_image", "Could not decode the image (use JPEG, PNG or WebP).")
        h, w = img.shape[:2]
        if max(h, w) > MAX_SIDE:
            s = MAX_SIDE / max(h, w)
            img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        return img

    def language(data: dict) -> str:
        lang = str(data.get("language", "en") or "en").lower()[:2]
        if lang not in LANGS:
            raise ApiError(400, "invalid_language", "language must be one of: en, hi, pa.")
        return lang

    def text_field(data: dict, key: str, limit: int) -> str:
        v = data.get(key)
        if not isinstance(v, str) or not v.strip():
            raise ApiError(400, f"missing_{key}", f"'{key}' is required.")
        if len(v) > limit:
            raise ApiError(400, f"{key}_too_long", f"'{key}' must be at most {limit} characters.")
        return v.strip()

    def history_field(data: dict) -> list[dict]:
        h = data.get("history", [])
        if isinstance(h, str) and h:
            import json

            try:
                h = json.loads(h)
            except ValueError:
                raise ApiError(400, "invalid_history", "'history' must be a JSON array.")
        if not h:
            return []
        if not isinstance(h, list) or len(h) > 20:
            raise ApiError(400, "invalid_history", "'history' must be a list of at most 20 messages.")
        out = []
        for m in h:
            if not (isinstance(m, dict) and m.get("role") in {"user", "assistant"} and isinstance(m.get("content"), str)):
                raise ApiError(400, "invalid_history", "Each history item needs role (user|assistant) and content (string).")
            out.append({"role": m["role"], "content": m["content"][:1000]})
        return out

    def run_detector(img):
        det = manager.get()
        t0 = time.perf_counter()
        try:
            dets = det.detect(img)
        except Exception:
            log.exception("detector failed")
            raise ApiError(500, "detector_failed", "Object detection failed.")
        return det, dets, round((time.perf_counter() - t0) * 1000)

    def make_scene(img, det, dets):
        h, w = img.shape[:2]
        colors = [dominant_color(img, d.box) for d in dets]
        return vqa.build_scene(dets, w, h, colors, backend=getattr(det, "kind", ""), limited=bool(getattr(det, "limited", False)))

    # ------------------------------------------------------------------ routes
    @app.get("/health")
    def health():
        return jsonify({"ok": True})

    @app.get("/vision/status")
    def status():
        prov = llm.provider(cfg)
        model = cfg.gemini_model if prov == "gemini" else (cfg.llm_model if prov else None)
        return jsonify({
            "name": "VISION",
            "version": VERSION,
            "detector": manager.status(),
            "voice": voice.capabilities(cfg),
            "llm": {
                "configured": bool(prov),
                "provider": prov or None,
                "model": model,
            },
            "rag": {"enabled": cfg.enable_rag and not cfg.offline},
            "edu_models": edu_models.status(),
            "offline": cfg.offline,
            "auth_required": bool(cfg.api_token),
            "languages": sorted(LANGS),
        })

    @app.post("/voice/transcribe")
    def transcribe():
        f = request.files.get("audio")
        if f is None:
            raise ApiError(400, "missing_audio", "Send audio as multipart field 'audio'.")
        audio = f.read()
        if not audio:
            raise ApiError(400, "invalid_audio", "The audio is empty.")
        lang = request.form.get("language") or None
        if lang and lang not in LANGS:
            raise ApiError(400, "invalid_language", "language must be one of: en, hi, pa.")
        try:
            return jsonify(voice.transcribe(cfg, audio, lang))
        except voice.VoiceUnavailable as exc:
            raise ApiError(503, "stt_unavailable", str(exc), fallback="browser-speech-recognition")
        except Exception:
            log.exception("transcription failed")
            raise ApiError(422, "transcription_failed", "Could not transcribe this audio (unsupported or corrupt).")

    @app.post("/voice/speak")
    def speak():
        data = payload()
        text = text_field(data, "text", 1000)
        try:
            speed = float(data.get("speed", 1.0))
        except (TypeError, ValueError):
            raise ApiError(400, "invalid_speed", "speed must be a number between 0.5 and 2.0.")
        if not 0.5 <= speed <= 2.0:
            raise ApiError(400, "invalid_speed", "speed must be a number between 0.5 and 2.0.")
        language(data)
        try:
            wav = voice.synthesize(cfg, text, speed, language(data))
        except voice.VoiceUnavailable as exc:
            raise ApiError(501, "tts_unavailable", str(exc), fallback="browser-speech-synthesis")
        return Response(wav, mimetype="audio/wav")

    @app.post("/vision/detect")
    def detect():
        img = read_image()
        det, dets, ms = run_detector(img)
        h, w = img.shape[:2]
        return jsonify({
            "backend": det.kind, "limited": bool(getattr(det, "limited", False)),
            "image": {"width": w, "height": h}, "count": len(dets),
            "objects": [d.to_dict() for d in dets], "timing_ms": ms,
        })

    @app.post("/vision/analyze")
    def analyze():
        img = read_image()
        det, dets, ms = run_detector(img)
        scene = make_scene(img, det, dets)
        scene["timing_ms"] = ms
        return jsonify(scene)

    @app.post("/vision/ask")
    def ask():
        img = read_image()
        data = payload()
        question = text_field(data, "question", 500)
        lang, hist = language(data), history_field(data)
        det, dets, ms = run_detector(img)
        scene = make_scene(img, det, dets)
        ok, buf = cv2.imencode(".jpg", img)
        img_bytes = buf.tobytes() if ok else None
        result = bot.respond(question, hist, lang, scene, image_bytes=img_bytes)
        return jsonify({
            "question": question,
            "answer": result["answer"],
            "reply": result["answer"],
            "source": result["source"],
            "references": result.get("references", []),
            "scene": scene,
            "timing_ms": ms,
        })

    @app.post("/vision/classify")
    def classify():
        if bot.cnn is None:
            raise ApiError(503, "cnn_unavailable", "CNN not trained. Run: python -m modules.edu_models train-cnn")
        img = read_image()
        box = payload().get("box")
        if isinstance(box, dict):
            try:
                x1, y1, x2, y2 = (int(box[k]) for k in ("x1", "y1", "x2", "y2"))
            except (KeyError, TypeError, ValueError):
                raise ApiError(400, "invalid_box", "box needs integer x1, y1, x2, y2.")
            crop = img[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]
            if crop.size == 0:
                raise ApiError(400, "invalid_box", "box is outside the image.")
            img = crop
        return jsonify({"model": "SmallCNN (CIFAR-10, educational)", "predictions": bot.cnn.classify(img)})

    def _handle_chat():
        data = payload()
        message = text_field(data, "message", 2000)
        hist = history_field(data)
        lang = language(data)
        result = bot.respond(message, hist, lang, None)
        prov = llm.provider(cfg)
        model_name = cfg.gemini_model if prov == "gemini" else (cfg.llm_model if prov else "local")
        return jsonify({
            "success": not result.get("error", False),
            "reply": result["answer"],
            "answer": result["answer"],
            "model": model_name,
            "source": result["source"],
            "references": result.get("references", []),
        })

    @app.post("/chat")
    def chat():
        return _handle_chat()

    @app.post("/api/chat")
    def api_chat():
        return _handle_chat()

    # ------------------------------------------------------------------ static frontend (desktop + production)
    dist = Path(cfg.frontend_dist)

    @app.get("/", defaults={"path": ""})
    @app.get("/<path:path>")
    def frontend(path: str):
        if is_api(request.path):
            raise ApiError(404, "not_found", "Not found.")
        if dist.is_dir():
            target = (dist / path).resolve()
            if path and target.is_file() and dist.resolve() in target.parents:
                return send_from_directory(dist, path)
            return send_from_directory(dist, "index.html")
        return jsonify({"name": "VISION backend", "version": VERSION,
                        "hint": "Frontend not built. Run the Vite dev server (npm run dev:web) or build it (npm run build:web)."})

    return app


# Module-level WSGI callable for production servers (e.g. gunicorn app:app)
app = create_app(warmup=True)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    _cfg = Config.from_env()
    _app = create_app(_cfg, warmup=True)
    print(f"VISION backend on http://{_cfg.host}:{_cfg.port}")
    _app.run(host=_cfg.host, port=_cfg.port, threaded=True, debug=False)
