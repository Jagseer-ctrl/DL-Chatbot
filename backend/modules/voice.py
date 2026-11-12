"""Speech-to-text (Whisper) and text-to-speech (Piper), both optional.

STT: faster-whisper preferred (decodes audio itself, runs on CPU, audio stays in memory),
     openai-whisper as a fallback (needs ffmpeg + a temp file that is deleted immediately).
TTS: Piper CLI with a downloaded .onnx voice. If absent, the frontend falls back to the
     browser's speech synthesis, so speech output still works.
"""
from __future__ import annotations

import importlib.util
import io
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading

log = logging.getLogger("vision.voice")
LANGS = {"en", "hi", "pa"}


class VoiceUnavailable(RuntimeError):
    pass


_models: dict = {}
_lock = threading.Lock()


def _have(mod: str) -> bool:
    return importlib.util.find_spec(mod) is not None


def _piper_cmd() -> list[str] | None:
    exe = shutil.which("piper")
    if exe:
        return [exe]
    if _have("piper"):
        return [sys.executable, "-m", "piper"]
    return None


def stt_engine() -> str | None:
    if _have("faster_whisper"):
        return "faster-whisper"
    if _have("whisper"):
        return "openai-whisper"
    return None


def _piper_model(cfg, language: str | None = None) -> str:
    language_model = getattr(cfg, f"piper_model_{language}", "") if language in LANGS else ""
    return language_model or cfg.piper_model


def tts_engine(cfg, language: str | None = None) -> str | None:
    if _piper_model(cfg, language) and os.path.exists(_piper_model(cfg, language)) and _piper_cmd():
        return "piper"
    return None


def capabilities(cfg) -> dict:
    tts_languages = [lang for lang in sorted(LANGS) if tts_engine(cfg, lang)]
    return {
        "stt": stt_engine(),
        "tts": bool(tts_languages),
        "tts_languages": tts_languages,
        "stt_model": cfg.whisper_model if stt_engine() else None,
        "browser_fallback": True,
        "languages": sorted(LANGS),
    }


def transcribe(cfg, audio: bytes, language: str | None) -> dict:
    engine = stt_engine()
    if not engine:
        raise VoiceUnavailable("No speech-to-text engine installed (pip install -r requirements-voice.txt)")
    lang = language if language in LANGS else None
    with _lock:  # one model instance, one transcription at a time on CPU
        if engine == "faster-whisper":
            from faster_whisper import WhisperModel

            model = _models.get(engine) or _models.setdefault(
                engine, WhisperModel(cfg.whisper_model, device="cpu", compute_type="int8")
            )
            segments, info = model.transcribe(io.BytesIO(audio), language=lang, vad_filter=True, beam_size=1)
            text = " ".join(s.text.strip() for s in segments).strip()
            return {"text": text, "language": info.language, "engine": engine}
        import whisper

        model = _models.get(engine) or _models.setdefault(engine, whisper.load_model(cfg.whisper_model))
        fd, path = tempfile.mkstemp(suffix=".wav")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(audio)
            res = model.transcribe(path, language=lang, fp16=False)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        return {"text": res.get("text", "").strip(), "language": res.get("language", lang), "engine": engine}


def synthesize(cfg, text: str, speed: float = 1.0, language: str = "en") -> bytes:
    model_path = _piper_model(cfg, language)
    if not tts_engine(cfg, language):
        raise VoiceUnavailable("Piper is not configured (set VISION_PIPER_MODEL to a .onnx voice file)")
    fd, out = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        cmd = _piper_cmd() + ["--model", model_path, "--output_file", out, "--length_scale", f"{1.0 / max(0.5, min(2.0, speed)):.2f}"]
        proc = subprocess.run(cmd, input=text.encode("utf-8"), capture_output=True, timeout=60)
        if proc.returncode != 0:
            log.warning("piper failed: %s", proc.stderr.decode(errors="replace")[:200])
            raise VoiceUnavailable("Piper failed to synthesise speech")
        with open(out, "rb") as fh:
            return fh.read()
    except subprocess.TimeoutExpired as exc:
        raise VoiceUnavailable("Piper timed out") from exc
    finally:
        try:
            os.remove(out)
        except OSError:
            pass
