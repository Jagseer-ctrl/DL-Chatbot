"""Offline object facts + online retrieval (Wikipedia) for the RAG path."""
from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.parse
import urllib.request

from .vqa import find_targets

log = logging.getLogger("vision.knowledge")

OBJECT_FACTS = {
    "laptop": "A laptop is a portable computer used for programming, studying, communication, and other computing tasks.",
    "cell phone": "A mobile phone is a handheld device used for calls, messages, the internet, photos and many apps.",
    "tv": "A monitor or TV displays video from a computer or other source, used for work, entertainment and presentations.",
    "keyboard": "A keyboard is an input device used to type text and send commands to a computer.",
    "mouse": "A computer mouse is a pointing device used to move a cursor and click on a screen.",
    "bottle": "A bottle is a container, usually with a narrow neck, used to store and carry liquids such as water.",
    "cup": "A cup is a small open container used for drinking.",
    "book": "A book is a set of written or printed pages used for reading, learning and storytelling.",
    "chair": "A chair is a seat with a back, used for sitting at a desk, table or in a room.",
    "dining table": "A table is a flat-topped piece of furniture used for eating, working or placing things on.",
    "couch": "A sofa is a long, cushioned seat for several people, used for relaxing.",
    "bed": "A bed is a piece of furniture used for sleeping and resting.",
    "car": "A car is a road vehicle with an engine or motor, used to carry people and goods.",
    "bicycle": "A bicycle is a two-wheeled vehicle powered by pedalling, used for transport, exercise and sport.",
    "motorcycle": "A motorcycle is a two-wheeled motor vehicle used for transport and sport.",
    "person": "A person is a human being. VISION can detect that a person is present but never identifies people by their faces.",
    "backpack": "A backpack is a bag carried on the back, used for books, laptops and personal items.",
    "clock": "A clock is a device that shows the time.",
    "umbrella": "An umbrella is a folding canopy used for protection against rain or sun.",
    "scissors": "Scissors are a cutting tool with two blades, used for cutting paper, cloth and other thin materials.",
    "remote": "A remote control is a handheld device used to operate a TV or other electronics from a distance.",
    "cat": "A cat is a small domesticated mammal, often kept as a pet.",
    "dog": "A dog is a domesticated mammal, kept as a pet and used for guarding, herding and assistance.",
    "bird": "A bird is a warm-blooded animal with feathers and wings; most species can fly.",
    "potted plant": "A potted plant is a plant grown in a pot, kept indoors or on balconies for decoration and fresh air.",
}

_RE_ABOUT = re.compile(r"\b(what is|what's|what are|tell me about|explain|used for|use of|uses of|define|meaning of)\b")


def object_fact_answer(question: str) -> str | None:
    q = question.lower()
    if not _RE_ABOUT.search(q):
        return None
    for label in find_targets(q):
        if label in OBJECT_FACTS:
            return OBJECT_FACTS[label]
    return None


# --------------------------------------------------------------------------- online
FACTUAL = re.compile(
    r"^(what|who|when|where|why|how|which|explain|tell me|define|describe)\b|\b(meaning of|capital of|history of|difference between)\b"
)


def looks_factual(question: str) -> bool:
    return bool(FACTUAL.search(question.lower().strip()))


def _get_json(url: str, timeout: float) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "VISION-Assistant/1.0 (educational project)"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - fixed https hosts only
        return json.loads(resp.read().decode("utf-8"))


def _clean_query(q: str) -> str:
    q = re.sub(r"[?!.]+$", "", q.strip())
    q = re.sub(r"^(please\s+)?(what is|what's|what are|who is|who was|tell me about|explain|define|describe)\s+(a |an |the )?", "", q, flags=re.I)
    return q.strip() or q


def _first_sentences(text: str, n: int = 2, limit: int = 420) -> str:
    parts = re.split(r"(?<=[.!?।])\s+", text.strip())
    out = " ".join(parts[:n])
    return out if len(out) <= limit else out[: limit - 1].rsplit(" ", 1)[0] + "…"


def wiki_lookup(query: str, lang: str = "en", timeout: float = 6.0) -> dict | None:
    """Return {title, extract, url} for the best Wikipedia match, or None. Never raises."""
    lang = lang if lang in {"en", "hi", "pa"} else "en"
    base = f"https://{lang}.wikipedia.org"
    try:
        params = urllib.parse.urlencode(
            {"action": "query", "list": "search", "srsearch": _clean_query(query), "srlimit": 1, "format": "json"}
        )
        hits = _get_json(f"{base}/w/api.php?{params}", timeout).get("query", {}).get("search", [])
        if not hits:
            return None
        title = hits[0]["title"]
        s = _get_json(f"{base}/api/rest_v1/page/summary/{urllib.parse.quote(title.replace(' ', '_'))}", timeout)
        extract = _first_sentences(s.get("extract", ""))
        if not extract:
            return None
        return {"title": title, "extract": extract, "url": s.get("content_urls", {}).get("desktop", {}).get("page", base)}
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError, OSError) as exc:
        log.info("wikipedia lookup failed: %s", exc)
        return None
