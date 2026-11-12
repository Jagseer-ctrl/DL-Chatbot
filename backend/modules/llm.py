"""Minimal LLM client (Anthropic Messages API or any OpenAI-compatible endpoint).

Uses only the standard library so there is nothing extra to install. API keys are
read from the backend environment and are never sent to the frontend.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

SYSTEM_PROMPT = """You are VISION, a friendly, professional voice assistant.
Your replies are spoken aloud, so keep them short (1-3 sentences) unless the user asks for detail, and avoid markdown, lists and emojis.
Reply naturally in the selected UI language supplied with the request (English, Hindi or Punjabi).
If a "Camera context" block is provided, use ONLY it for questions about the user's surroundings. Never claim to see anything that is not listed there, say plainly when you are unsure or when the detector may have missed something, and never identify people by their faces.
If "Reference" text is provided, base factual claims on it and do not invent details beyond it.
If you don't know something, say so."""


class LLMError(RuntimeError):
    pass


def provider(cfg) -> str:
    if cfg.offline:
        return ""
    if cfg.llm_provider in {"anthropic", "openai"}:
        key = cfg.anthropic_api_key if cfg.llm_provider == "anthropic" else cfg.openai_api_key
        return cfg.llm_provider if key else ""
    if cfg.anthropic_api_key:
        return "anthropic"
    if cfg.openai_api_key:
        return "openai"
    return ""


def _post(url: str, headers: dict, body: dict, timeout: float) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), headers={"Content-Type": "application/json; charset=utf-8", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        raise LLMError(f"LLM HTTP {exc.code}") from exc  # body deliberately not echoed (may contain request details)
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        raise LLMError(f"LLM request failed: {type(exc).__name__}") from exc


def complete(cfg, messages: list[dict], extra_system: str = "", language: str = "en", timeout: float = 90.0) -> str:
    prov = provider(cfg)
    if not prov:
        raise LLMError("no LLM configured")
    language_name = {"en": "English", "hi": "Hindi", "pa": "Punjabi"}.get(language, "English")
    system = f"{SYSTEM_PROMPT}\n\nThe selected UI language is {language_name}. Always answer in {language_name}."
    if extra_system:
        system += "\n\n" + extra_system
    if prov == "anthropic":
        data = _post(
            "https://api.anthropic.com/v1/messages",
            {"x-api-key": cfg.anthropic_api_key, "anthropic-version": "2023-06-01"},
            {"model": cfg.llm_model, "max_tokens": 400, "system": system, "messages": messages},
            timeout,
        )
        try:
            return "".join(b.get("text", "") for b in data["content"] if b.get("type") == "text").strip()
        except (KeyError, TypeError) as exc:
            raise LLMError("unexpected Anthropic response") from exc
    data = _post(
        f"{cfg.openai_base_url}/chat/completions",
        {"Authorization": f"Bearer {cfg.openai_api_key}"},
        {"model": cfg.llm_model, "max_tokens": 400, "messages": [{"role": "system", "content": system}, *messages]},
        timeout,
    )
    try:
        return data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise LLMError("unexpected OpenAI response") from exc
