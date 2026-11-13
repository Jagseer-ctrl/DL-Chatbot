"""Conversation router powered by Google Gemini AI with local computer vision fallback.

When GEMINI_API_KEY is configured:
  Routes queries to Gemini with multi-turn conversation memory, context awareness,
  programming assistance, detailed technical explanations, and optional camera vision.

When offline or no API key is configured:
  Provides helpful local fallback answers and clear instructions on configuring GEMINI_API_KEY.
"""
from __future__ import annotations

import logging
import re

from . import edu_models, knowledge, llm, vqa

log = logging.getLogger("vision.chat")

SMALLTALK = {
    "greeting": {
        "en": "Hello! How can I help you?",
        "hi": "नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?",
        "pa": "ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ! ਮੈਂ ਤੁਹਾਡੀ ਕੀ ਮਦਦ ਕਰ ਸਕਦਾ ਹਾਂ?",
    },
    "thanks": {
        "en": "You're welcome! Let me know if you need anything else.",
        "hi": "आपका स्वागत है! यदि आपको किसी और चीज़ की आवश्यकता हो तो मुझे बताएं।",
        "pa": "ਤੁਹਾਡਾ ਸਵਾਗਤ ਹੈ! ਜੇਕਰ ਤੁਹਾਨੂੰ ਹੋਰ ਕਿਸੇ ਚੀਜ਼ ਦੀ ਲੋੜ ਹੋਵੇ ਤਾਂ ਦੱਸੋ।",
    },
    "goodbye": {
        "en": "Goodbye! Have a great day ahead. Say 'Hey Vision' whenever you need me.",
        "hi": "अलविदा! आपका दिन शुभ हो। जब भी आवश्यकता हो 'Hey Vision' कहें।",
        "pa": "ਅਲਵਿਦਾ! ਤੁਹਾਡਾ ਦਿਨ ਵਧੀਆ ਰਹੇ। ਜਦੋਂ ਵੀ ਲੋੜ ਹੋਵੇ 'Hey Vision' ਕਹੋ।",
    },
    "identity": {
        "en": "I'm VISION, an Ambient AI voice and vision desk assistant powered by Google Gemini. I can chat, write code, explain concepts, and analyze what's visible through your camera.",
        "hi": "मैं विज़न हूँ, एक एम्बिएंट AI आवाज़ और विज़न डेस्क सहायक जो Google Gemini द्वारा संचालित है।",
        "pa": "ਮੈਂ ਵਿਜ਼ਨ ਹਾਂ, Google Gemini ਦੁਆਰਾ ਸੰਚਾਲਿਤ ਇੱਕ AI ਡੈਸਕ ਸਹਾਇਕ।",
    },
    "capabilities": {
        "en": "I can converse naturally in English, Hindi and Punjabi, write and debug code, answer technical questions, explain complex topics, detect objects via camera, and describe what I see.",
        "hi": "मैं अंग्रेजी, हिंदी और पंजाबी में बातचीत कर सकता हूँ, कोड लिख सकता हूँ और कैमरे के माध्यम से वस्तुओं का विश्लेषण कर सकता हूँ।",
        "pa": "ਮੈਂ ਅੰਗਰੇਜ਼ੀ, ਹਿੰਦੀ ਅਤੇ ਪੰਜਾਬੀ ਵਿੱਚ ਗੱਲਬਾਤ ਕਰ ਸਕਦਾ ਹਾਂ, ਕੋਡ ਲਿਖ ਸਕਦਾ ਹਾਂ ਅਤੇ ਕੈਮਰੇ ਰਾਹੀਂ ਦੇਖ ਸਕਦਾ ਹਾਂ।",
    },
}

KEYWORD_INTENTS = [
    ("greeting", r"^(hello|hi|hey|namaste|नमस्ते|ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ|sat sri akal|good (morning|afternoon|evening))\b.{0,20}$"),
    ("thanks", r"^(thanks|thank you|cheers|धन्यवाद|शुक्रिया|ਧੰਨਵਾਦ)\b"),
    ("goodbye", r"^(bye|goodbye|good night|see you)\b"),
    ("identity", r"\b(who are you|your name|what are you|introduce yourself)\b"),
    ("capabilities", r"\b(what can you do|what are your features|how can you help)\b"),
]


def _keyword_intent(text: str) -> tuple[str, float]:
    t = text.lower().strip().strip("?!. ")
    for name, pat in KEYWORD_INTENTS:
        if re.search(pat, t):
            return name, 1.0
    return "other", 0.0


class Assistant:
    def __init__(self, cfg):
        self.cfg = cfg
        self.intent_model = edu_models.IntentModel.load()
        self.cnn = edu_models.CnnClassifier.load()

    def _intent(self, text: str) -> tuple[str, float, str]:
        kw, kc = _keyword_intent(text)
        if kw != "other":
            return kw, kc, "keyword"
        if self.intent_model:
            label, conf = self.intent_model.predict(text)
            if label != "other" and conf >= 0.8:
                return label, conf, self.intent_model.cell
        return "other", 0.0, "none"

    def _online_ok(self) -> bool:
        return not getattr(self.cfg, "offline", False)

    def respond(
        self,
        message: str,
        history: list[dict],
        language: str = "en",
        scene: dict | None = None,
        image_bytes: bytes | None = None,
    ) -> dict:
        text = message.strip()
        if not text:
            return {"answer": "Please ask a question or say something.", "source": "prompt", "references": []}

        provider_name = llm.provider(self.cfg)

        # -------------------------------------------------------------
        # 1. PRIMARY: If Gemini or another LLM is configured, route everything to AI
        # -------------------------------------------------------------
        if provider_name:
            extra = []
            if scene is not None:
                extra.append("Camera context:\n" + vqa.llm_context(scene))

            fact = knowledge.object_fact_answer(text)
            if fact:
                extra.append("Reference:\n" + fact)

            # Build multi-turn message history for context-aware conversation
            msgs = []
            for m in (history or [])[-10:]:
                role = m.get("role")
                content = m.get("content") or m.get("text") or ""
                if role in {"user", "assistant"} and content.strip():
                    msgs.append({"role": role, "content": content.strip()})

            msgs.append({"role": "user", "content": text})

            # Ensure first message in conversation history starts with a user message
            while msgs and msgs[0]["role"] != "user":
                msgs.pop(0)

            try:
                answer = llm.complete(
                    self.cfg,
                    msgs,
                    extra_system="\n\n".join(extra),
                    language=language,
                    image_bytes=image_bytes,
                )
            except TypeError:
                # Compatibility for monkeypatched tests that don't accept image_bytes
                answer = llm.complete(
                    self.cfg,
                    msgs,
                    extra_system="\n\n".join(extra),
                    language=language,
                )

            if not answer:
                raise llm.LLMError("The model returned an empty response")

            source_tag = f"gemini:{getattr(self.cfg, 'gemini_model', 'flash')}" if provider_name == "gemini" else provider_name
            return {"answer": answer, "source": source_tag, "references": []}

        # -------------------------------------------------------------
        # 2. FALLBACK: When no LLM / Gemini key is configured
        # -------------------------------------------------------------
        # Exact local camera detections (exact counts, objects, colours)
        local = vqa.answer_local(text, scene) if scene is not None else None
        if local and language == "en":
            return {"answer": local, "source": "vision-local", "references": []}
        # Smalltalk fallback
        intent, conf, via = self._intent(text)
        if intent in SMALLTALK and conf >= 0.8:
            table = SMALLTALK[intent]
            base_ans = table.get(language) or table["en"]
            return {"answer": base_ans, "source": f"smalltalk:{via}", "references": []}

        # Object facts fallback
        fact = knowledge.object_fact_answer(text)
        if fact:
            return {"answer": fact, "source": "object-facts", "references": []}

        # Wikipedia fallback
        if knowledge.looks_factual(text) and getattr(self.cfg, "enable_rag", True) and self._online_ok():
            reference = knowledge.wiki_lookup(text, language)
            if reference:
                return {"answer": reference["extract"], "source": "rag:wikipedia", "references": [reference]}

        # If camera scene is present and user asks general camera questions
        if scene is not None and scene.get("count") is not None and language == "en" and re.search(r"\b(see|camera|front|here)\b", text.lower()):
            return {"answer": scene["summary"], "source": "vision-local", "references": []}

        # Clear, actionable notice that GEMINI_API_KEY is needed for open-ended intelligence
        setup_notice = (
            "I don't have enough configured knowledge to answer that confidently. "
            "Configure GEMINI_API_KEY on the backend for open-ended answers."
        )
        return {"answer": setup_notice, "source": "fallback", "references": []}
