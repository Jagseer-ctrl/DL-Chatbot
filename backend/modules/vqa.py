"""Visual question answering over detector output.

Pipeline: detections -> scene dict (counts, positions, colours) -> either
  (a) deterministic local answers for count / list / colour / position / presence
      questions (exact, offline, can't hallucinate), or
  (b) a text context block handed to the LLM for everything else.
VISION never claims to see anything the detector did not report.
"""
from __future__ import annotations

import re
from collections import Counter

from .detector import friendly

LOW_CONF = 0.5

SYNONYMS = {
    "cell phone": ["phone", "mobile", "smartphone", "cellphone", "cell phone"],
    "laptop": ["laptop", "notebook", "computer", "macbook"],
    "tv": ["tv", "television", "monitor", "screen", "display"],
    "bottle": ["bottle", "water bottle"],
    "person": ["person", "people", "man", "woman", "human", "someone", "anyone", "somebody"],
    "chair": ["chair", "chairs"],
    "dining table": ["table", "desk"],
    "book": ["book", "books"],
    "car": ["car", "cars", "vehicle"],
    "cup": ["cup", "mug"],
    "keyboard": ["keyboard"],
    "mouse": ["mouse"],
    "backpack": ["backpack", "bag", "rucksack"],
    "clock": ["clock"],
    "cat": ["cat"],
    "dog": ["dog"],
    "bird": ["bird"],
    "bicycle": ["bicycle", "bike", "cycle"],
    "motorcycle": ["motorcycle", "motorbike", "scooter"],
    "couch": ["couch", "sofa"],
    "bed": ["bed"],
    "scissors": ["scissors"],
    "remote": ["remote"],
    "umbrella": ["umbrella"],
    "potted plant": ["plant"],
}

PLURALS = {"person": "people", "knife": "knives", "sheep": "sheep", "scissors": "scissors", "bus": "buses"}
NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]


def _num(n: int) -> str:
    return NUMBER_WORDS[n] if n < len(NUMBER_WORDS) else str(n)


def _noun(label: str, n: int = 1) -> str:
    name = friendly(label)
    if n == 1:
        return name
    return PLURALS.get(label) or (name if name.endswith("s") else name + "s")


def _article(name: str) -> str:
    return "an" if name[0] in "aeiou" else "a"


def _join(items: list[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


# --------------------------------------------------------------------------- scene
def _position(box: dict, w: int, h: int) -> str:
    cx = (box["x1"] + box["x2"]) / 2 / w
    cy = (box["y1"] + box["y2"]) / 2 / h
    horiz = "left" if cx < 1 / 3 else "right" if cx > 2 / 3 else "center"
    vert = "top" if cy < 1 / 3 else "bottom" if cy > 2 / 3 else "middle"
    if horiz == "center" and vert == "middle":
        return "center"
    if horiz == "center":
        return f"{vert} center"
    if vert == "middle":
        return horiz
    return f"{vert} {horiz}"


def build_scene(detections: list, width: int, height: int, colors: list | None = None,
                backend: str = "", limited: bool = False) -> dict:
    objects = []
    for i, d in enumerate(detections):
        o = d.to_dict()
        o["position"] = _position(o["box"], width, height)
        o["area_pct"] = round(100 * (d.box[2] - d.box[0]) * (d.box[3] - d.box[1]) / (width * height), 1)
        o["color"] = colors[i] if colors and i < len(colors) else None
        objects.append(o)
    counts = Counter(o["label"] for o in objects)
    scene = {
        "backend": backend,
        "limited": limited,
        "image": {"width": width, "height": height},
        "count": len(objects),
        "counts": dict(counts),
        "objects": objects,
    }
    scene["summary"] = describe(scene)
    return scene


def describe(scene: dict) -> str:
    objs = scene["objects"]
    limited_note = " (Limited mode: only people can be detected until YOLO is installed.)" if scene.get("limited") else ""
    if not objs:
        return ("I can't identify any of the everyday objects my model supports in this frame. "
                "It only knows a fixed set of objects, so something may be there that I can't recognise." + limited_note)
    sure = Counter(o["label"] for o in objs if o["confidence"] >= LOW_CONF)
    unsure = [o for o in objs if o["confidence"] < LOW_CONF and o["label"] not in sure]
    parts = []
    if sure:
        phrases = [(f"{_article(_noun(l))} {_noun(l)}" if n == 1 else f"{_num(n)} {_noun(l, n)}") for l, n in sure.items()]
        parts.append(f"I can identify {_join(phrases)} in the current camera frame.")
    if unsure:
        names = _join(sorted({friendly(o['label']) for o in unsure}))
        best = max(o["confidence"] for o in unsure)
        parts.append(f"I'm not very sure, but it might also include {names} (confidence about {round(best * 100)}%).")
    return " ".join(parts) + limited_note


def llm_context(scene: dict) -> str:
    img = scene["image"]
    lines = [
        f"Camera frame {img['width']}x{img['height']}. Detector: {scene.get('backend') or 'unknown'}"
        + (" (limited: people only)" if scene.get("limited") else "") + ".",
        "The detector only knows a fixed set of everyday object classes; absence from this list does NOT prove absence from the room.",
        f"Total detected objects: {scene['count']}.",
    ]
    for i, o in enumerate(scene["objects"], 1):
        col = f", dominant colour (rough estimate): {o['color']['name']}" if o.get("color") else ""
        lines.append(f"{i}. {o['name']} - confidence {o['confidence']:.2f} - position: {o['position']}{col}")
    return "\n".join(lines)


# --------------------------------------------------------------------------- targets
def find_targets(text: str) -> list[str]:
    """COCO labels mentioned in the text (checked against ALL known labels, not just detected ones)."""
    t = text.lower()
    found = []
    for label, words in SYNONYMS.items():
        if any(re.search(rf"\b{re.escape(w)}\b", t) for w in words):
            found.append(label)
    # "mouse" inside "computer mouse" etc. is fine; "computer" alone maps to laptop only
    return found


# --------------------------------------------------------------------------- local answers
_RE_CONF = re.compile(r"how (sure|confident|certain|accurate)|confidence|accura")
_RE_COLOR = re.compile(
    r"\b(?:what|which)\s+(?:is\s+)?(?:the\s+)?colou?rs?\b|"
    r"\b(?:name|estimate|tell me)\s+(?:the\s+)?colou?rs?\b|"
    r"\bcolou?rs?\s+(?:of|is|are)\b"
)
_RE_COUNT = re.compile(r"how many|\bcount\b|number of")
_RE_WHERE = re.compile(r"\bwhere\b|\bposition\b|located|which side")
_RE_PRESENT = re.compile(r"\b(is there|are there|do you see|can you see|do you detect|can you detect|any)\b")
_RE_DESCRIBE = re.compile(
    r"\bwhat\b.*\b(see|detect|recogni[sz]e|identify|spot|notice)\b|in front of me|"
    r"\bdescribe\b.*(scene|view|frame|see|around|room)|what('s| is) (in )?(front|around)|what am i (holding|looking)"
)


def answer_local(question: str, scene: dict) -> str | None:
    """Return an answer for questions we can answer exactly from the scene, else None."""
    q = question.lower().strip()
    objs = scene["objects"]
    targets = find_targets(q)
    in_scene = [t for t in targets if scene["counts"].get(t)]

    if _RE_CONF.search(q):
        if not objs:
            return "I haven't detected anything, so there's no confidence to report."
        top = ", ".join(f"{o['name']} {round(o['confidence'] * 100)}%" for o in objs[:6])
        return f"My detection confidence is: {top}. Lower numbers mean I'm less sure."

    if _RE_COLOR.search(q):
        pool = [o for o in objs if o["label"] in targets] if targets else objs
        if targets and not pool:
            return f"I don't detect {_article(_noun(targets[0]))} {_noun(targets[0])} in this frame, so I can't tell its colour."
        pool = [o for o in pool if o.get("color")][:5]
        if not pool:
            return "I can't judge a colour right now - nothing suitable was detected."
        if len(pool) == 1:
            o = pool[0]
            return (f"The {o['name']} appears {o['color']['name']}. "
                    "That's an estimate from the image and depends on lighting.")
        bits = [f"the {o['name']} ({o['position']}) looks {o['color']['name']}" for o in pool]
        return _join(bits).capitalize() + ". These colours are rough estimates that depend on lighting."

    if _RE_COUNT.search(q):
        if targets:
            t = targets[0]
            n = scene["counts"].get(t, 0)
            if n == 0:
                return f"I don't detect any {_noun(t, 2)} in this frame."
            return f"I detected {_num(n)} {_noun(t, n)} in this frame."
        n = scene["count"]
        if n == 0:
            return "I detected no supported objects in this frame."
        return f"I detected {_num(n)} supported object{'s' if n != 1 else ''} in this frame."

    if _RE_WHERE.search(q) and targets:
        pool = [o for o in objs if o["label"] in targets]
        if not pool:
            return f"I don't detect {_article(_noun(targets[0]))} {_noun(targets[0])} in this frame."
        return _join([f"the {o['name']} is at the {o['position']} of the frame" for o in pool[:4]]).capitalize() + "."

    if _RE_PRESENT.search(q) and targets:
        t = targets[0]
        if t in in_scene:
            n = scene["counts"][t]
            best = max(o["confidence"] for o in objs if o["label"] == t)
            hedge = "Yes, " if best >= LOW_CONF else "Possibly - "
            return f"{hedge}I detect {_num(n)} {_noun(t, n)} (confidence about {round(best * 100)}%)."
        return f"No, I don't detect {_article(_noun(t))} {_noun(t)} in this frame. My model only knows a fixed set of objects, so I could be missing it."

    if _RE_DESCRIBE.search(q) or (_RE_PRESENT.search(q) and not targets and "see" in q):
        return scene["summary"]

    return None
