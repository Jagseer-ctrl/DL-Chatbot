"""Central configuration for the VISION backend.

Everything is driven by environment variables (see ../.env.example) so the same
code runs as a local desktop backend and as a deployed web backend.
API keys live ONLY here, on the backend - the frontend never sees them.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

try:  # python-dotenv is optional
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:  # pragma: no cover
    pass


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, "1" if default else "0").strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


@dataclass
class Config:
    # --- server -----------------------------------------------------------
    host: str = "127.0.0.1"
    port: int = 5001  # 5000 is taken by AirPlay Receiver on macOS
    cors_origins: list = field(default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"])
    api_token: str = ""  # optional bearer token (server-to-server / desktop->remote)
    trust_proxy: bool = False  # set when running behind Caddy / nginx
    rate_limit_per_min: int = 120  # per client IP, 0 disables
    max_upload_mb: int = 12
    frontend_dist: str = str(ROOT / "frontend" / "dist")

    # --- vision -----------------------------------------------------------
    yolo_weights: str = "yolov8n.pt"
    confidence: float = 0.35
    prefer_yolo: bool = True

    # --- language model / RAG --------------------------------------------
    llm_provider: str = ""  # "anthropic" | "openai" | "" (auto from keys)
    llm_model: str = "claude-sonnet-5-5"
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    enable_rag: bool = True
    offline: bool = False  # forces no network calls (no LLM, no RAG)

    # --- voice ------------------------------------------------------------
    whisper_model: str = "base"
    piper_model: str = ""  # path to a Piper .onnx voice
    piper_model_en: str = ""
    piper_model_hi: str = ""
    piper_model_pa: str = ""

    @classmethod
    def from_env(cls) -> "Config":
        origins = os.getenv("VISION_CORS_ORIGINS", "*")
        return cls(
            host=os.getenv("VISION_HOST", "127.0.0.1"),
            port=_int("VISION_PORT", 5001),
            cors_origins=[o.strip() for o in origins.split(",") if o.strip()],
            api_token=os.getenv("VISION_API_TOKEN", ""),
            trust_proxy=_bool("VISION_TRUST_PROXY", False),
            rate_limit_per_min=_int("VISION_RATE_LIMIT_PER_MIN", 120),
            max_upload_mb=_int("VISION_MAX_UPLOAD_MB", 12),
            frontend_dist=os.getenv("VISION_SERVE_FRONTEND", str(ROOT / "frontend" / "dist")),
            yolo_weights=os.getenv("VISION_YOLO_WEIGHTS", "yolov8n.pt"),
            confidence=_float("VISION_CONFIDENCE", 0.35),
            prefer_yolo=_bool("VISION_PREFER_YOLO", True),
            llm_provider=os.getenv("VISION_LLM_PROVIDER", "").strip().lower(),
            llm_model=os.getenv("VISION_LLM_MODEL", "claude-sonnet-5-5"),
            anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", ""),
            openai_api_key=os.getenv("OPENAI_API_KEY", ""),
            openai_base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/"),
            enable_rag=_bool("VISION_ENABLE_RAG", True),
            offline=_bool("VISION_OFFLINE", False),
            whisper_model=os.getenv("VISION_WHISPER_MODEL", "base"),
            piper_model=os.getenv("VISION_PIPER_MODEL", ""),
            piper_model_en=os.getenv("VISION_PIPER_MODEL_EN", ""),
            piper_model_hi=os.getenv("VISION_PIPER_MODEL_HI", ""),
            piper_model_pa=os.getenv("VISION_PIPER_MODEL_PA", ""),
        )
