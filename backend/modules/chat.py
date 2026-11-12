"""Conversation router.

Order of resolution for one user message:
  1. small talk (LSTM/RNN intent model if trained, else keyword baseline)
  2. English camera questions answerable exactly from detections (count/list/colour/position/presence)
  3. LLM (if a key is configured) with camera context and, for factual questions, Wikipedia reference text
  4. offline object facts ("what is a laptop used for")
  5. Wikipedia lookup (RAG without an LLM)
  6. honest "I don't know"
Camera context is only ever used when the frontend sent a scene for this request.
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
    "thanks": {"en": "You're welcome! Let me know if you need anything else."},
    "goodbye": {"en": "Goodbye! Say Hey Vision whenever you need me."},
    "identity": {"en": "I'm VISION, a voice and camera assistant. I can chat, answer questions, and describe everyday objects I can see through your camera when you turn it on."},
    "capabilities": {"en": "I can listen and speak in English, Hindi and Punjabi, detect everyday objects through your camera when you allow it, answer questions about them, and look up general knowledge."},
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
        return not self.cfg.offline

    def respond(self, message: str, history: list[dict], language: str = "en", scene: dict | None = None) -> dict:
        text = message.strip()

        intent, conf, via = self._intent(text)
        if intent in SMALLTALK and conf >= 0.8:
            table = SMALLTALK[intent]
            return {"answer": table.get(language) or table["en"], "source": f"smalltalk:{via}", "references": []}

        local = vqa.answer_local(text, scene) if scene is not None else None
        if local and language == "en":
            return {"answer": local, "source": "vision-local", "references": []}

        reference = None
        factual = knowledge.looks_factual(text) and local is None
        fact = knowledge.object_fact_answer(text)
        if llm.provider(self.cfg):
            extra = []
            if scene is not None:
                extra.append("Camera context:\n" + vqa.llm_context(scene))
            if fact:
                extra.append("Reference (built-in object facts):\n" + fact)
            msgs = [m for m in history[-8:] if m["role"] in {"user", "assistant"}] + [{"role": "user", "content": text}]
            while msgs and msgs[0]["role"] != "user":
                msgs.pop(0)
            answer = llm.complete(self.cfg, msgs, "\n\n".join(extra), language=language)
            if not answer:
                raise llm.LLMError("The model returned an empty response")
            return {"answer": answer, "source": "llm", "references": []}

        if local:  # non-English question but no LLM: still better than nothing
            return {"answer": local, "source": "vision-local", "references": []}

        if fact:
            return {"answer": fact, "source": "object-facts", "references": []}

        if factual and self.cfg.enable_rag and self._online_ok():
            reference = knowledge.wiki_lookup(text, language)
        if reference:
            return {"answer": reference["extract"], "source": "rag:wikipedia", "references": [reference]}

        if scene is not None and scene.get("count") is not None and language == "en" and re.search(r"\b(see|camera|front|here)\b", text.lower()):
            return {"answer": scene["summary"], "source": "vision-local", "references": []}

        msg = "I don't have enough configured knowledge to answer that confidently. "
        if not llm.provider(self.cfg):
            msg += "Configure ANTHROPIC_API_KEY or OPENAI_API_KEY on the backend for open-ended answers."
        else:
            msg += "Try rephrasing the question or include more context."
        return {"answer": msg, "source": "fallback", "references": []}
