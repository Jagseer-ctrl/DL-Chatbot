"""LLM client powered by Google Gemini (official Google Gen AI SDK with fallback REST API)
and compatible with Anthropic/OpenAI providers.

API keys live strictly in the backend environment and are never transmitted to the client.
"""
from __future__ import annotations

import base64
import json
import logging
import urllib.error
import urllib.request

log = logging.getLogger("vision.llm")

SYSTEM_PROMPT = """You are VISION, a sophisticated, professional Ambient AI Voice and Vision Desk Assistant powered by Google Gemini.
You are articulate, intelligent, warm, and highly capable.
- For conversational questions and greetings, be natural, concise, and helpful.
- For technical, educational, programming, or analytical questions, provide thorough, accurate, structured explanations with formatted code blocks and key points.
- When conversation history is provided, maintain context and coherence across multi-turn interactions.
- If a "Camera context" block or image frame is provided, analyze the visible surroundings carefully, truthfully, and in detail.
- Reply naturally in the user's selected language (English, Hindi, or Punjabi)."""


class LLMError(RuntimeError):
    pass


def provider(cfg) -> str:
    if getattr(cfg, "offline", False):
        return ""
    # Explicit provider preference
    if getattr(cfg, "llm_provider", "") == "gemini" and getattr(cfg, "gemini_api_key", ""):
        return "gemini"
    if getattr(cfg, "gemini_api_key", ""):
        return "gemini"
    if getattr(cfg, "anthropic_api_key", ""):
        return "anthropic"
    if getattr(cfg, "openai_api_key", ""):
        return "openai"
    return ""


def _post(url: str, headers: dict, body: dict, timeout: float) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8", **headers},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        err_msg = ""
        try:
            err_data = json.loads(exc.read().decode())
            err_msg = err_data.get("error", {}).get("message", "")
        except Exception:
            pass
        if exc.code == 429:
            raise LLMError("Gemini API rate limit or quota exceeded. Please wait a moment or check your API quota.") from exc
        if exc.code in {401, 403}:
            raise LLMError("Invalid or unauthorized Gemini API key. Please verify your GEMINI_API_KEY in Render settings.") from exc
        raise LLMError(f"LLM HTTP {exc.code}{': ' + err_msg if err_msg else ''}") from exc
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        raise LLMError(f"LLM request failed: {type(exc).__name__}") from exc


def _complete_gemini_sdk(
    api_key: str,
    model: str,
    messages: list[dict],
    system: str,
    image_bytes: bytes | None = None,
    mime_type: str = "image/jpeg",
) -> str:
    try:
        from google import genai
        from google.genai import types
    except ImportError as e:
        raise ImportError("google-genai package not found") from e

    client = genai.Client(api_key=api_key)
    contents = []

    for m in messages:
        role = "user" if m.get("role") == "user" else "model"
        text = m.get("content", "")
        if text:
            contents.append(types.Content(role=role, parts=[types.Part.from_text(text=text)]))

    if image_bytes:
        img_part = types.Part.from_bytes(data=image_bytes, mime_type=mime_type)
        if contents and contents[-1].role == "user":
            contents[-1].parts.insert(0, img_part)
        else:
            contents.append(types.Content(role="user", parts=[img_part]))

    if not contents:
        contents.append(types.Content(role="user", parts=[types.Part.from_text(text="Hello")]))

    config = types.GenerateContentConfig(
        system_instruction=system,
        temperature=0.7,
    )

    try:
        resp = client.models.generate_content(
            model=model,
            contents=contents,
            config=config,
        )
        if resp.text:
            return resp.text.strip()
        raise LLMError("Gemini returned an empty response.")
    except Exception as exc:
        err_str = str(exc)
        if "RESOURCE_EXHAUSTED" in err_str or "429" in err_str:
            raise LLMError("Gemini API rate limit or quota exceeded. Please wait a moment or verify your quota.") from exc
        if "API_KEY_INVALID" in err_str or "403" in err_str or "401" in err_str:
            raise LLMError("Invalid Gemini API key. Please check your GEMINI_API_KEY environment variable.") from exc
        raise LLMError(f"Gemini API error: {err_str}") from exc


def _complete_gemini_rest(
    api_key: str,
    model: str,
    messages: list[dict],
    system: str,
    image_bytes: bytes | None = None,
    mime_type: str = "image/jpeg",
    timeout: float = 90.0,
) -> str:
    # Zero-dependency REST fallback
    clean_model = model.replace("models/", "")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{clean_model}:generateContent?key={api_key}"

    contents = []
    for m in messages:
        role = "user" if m.get("role") == "user" else "model"
        text = m.get("content", "")
        parts = []
        if text:
            parts.append({"text": text})
        if parts:
            contents.append({"role": role, "parts": parts})

    if image_bytes:
        b64_data = base64.b64encode(image_bytes).decode("ascii")
        img_part = {"inlineData": {"mimeType": mime_type, "data": b64_data}}
        if contents and contents[-1]["role"] == "user":
            contents[-1]["parts"].insert(0, img_part)
        else:
            contents.append({"role": "user", "parts": [img_part]})

    if not contents:
        contents.append({"role": "user", "parts": [{"text": "Hello"}]})

    payload = {
        "contents": contents,
        "systemInstruction": {"parts": [{"text": system}]},
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 2048},
    }

    data = _post(url, {}, payload, timeout=timeout)
    try:
        candidates = data.get("candidates", [])
        if candidates:
            parts = candidates[0].get("content", {}).get("parts", [])
            text = "".join(p.get("text", "") for p in parts if "text" in p)
            if text:
                return text.strip()
        raise LLMError("Gemini returned an empty response.")
    except (KeyError, IndexError, TypeError) as exc:
        raise LLMError("Unexpected response structure from Gemini API.") from exc


def _complete_gemini(
    api_key: str,
    model: str,
    messages: list[dict],
    system: str,
    image_bytes: bytes | None = None,
    mime_type: str = "image/jpeg",
    timeout: float = 90.0,
) -> str:
    # Try official SDK first
    try:
        return _complete_gemini_sdk(api_key, model, messages, system, image_bytes, mime_type)
    except (ImportError, Exception) as sdk_exc:
        log.warning("Gemini SDK call failed, falling back to direct REST API: %s", sdk_exc)
        return _complete_gemini_rest(api_key, model, messages, system, image_bytes, mime_type, timeout)


def complete(
    cfg,
    messages: list[dict],
    extra_system: str = "",
    language: str = "en",
    image_bytes: bytes | None = None,
    mime_type: str = "image/jpeg",
    timeout: float = 90.0,
) -> str:
    prov = provider(cfg)
    if not prov:
        raise LLMError("No Gemini API key configured. Please set GEMINI_API_KEY in your backend environment variables.")

    language_name = {"en": "English", "hi": "Hindi", "pa": "Punjabi"}.get(language, "English")
    system = f"{SYSTEM_PROMPT}\n\nThe selected UI language is {language_name}. Always respond in {language_name}."
    if extra_system:
        system += "\n\n" + extra_system

    if prov == "gemini":
        model = getattr(cfg, "gemini_model", "gemini-2.5-flash") or "gemini-2.5-flash"
        return _complete_gemini(
            cfg.gemini_api_key,
            model,
            messages,
            system,
            image_bytes=image_bytes,
            mime_type=mime_type,
            timeout=timeout,
        )

    if prov == "anthropic":
        data = _post(
            "https://api.anthropic.com/v1/messages",
            {"x-api-key": cfg.anthropic_api_key, "anthropic-version": "2023-06-01"},
            {"model": cfg.llm_model, "max_tokens": 1000, "system": system, "messages": messages},
            timeout,
        )
        try:
            return "".join(b.get("text", "") for b in data["content"] if b.get("type") == "text").strip()
        except (KeyError, TypeError) as exc:
            raise LLMError("Unexpected Anthropic response") from exc

    if prov == "openai":
        data = _post(
            f"{cfg.openai_base_url}/chat/completions",
            {"Authorization": f"Bearer {cfg.openai_api_key}"},
            {"model": cfg.llm_model, "max_tokens": 1000, "messages": [{"role": "system", "content": system}, *messages]},
            timeout,
        )
        try:
            return data["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMError("Unexpected OpenAI response") from exc

    raise LLMError(f"Unsupported LLM provider: {prov}")
