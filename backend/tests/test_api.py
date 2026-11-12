"""Backend tests. Run from backend/:  python -m pytest -q

A scripted detector is injected so the full pipeline (image decode -> detection -> colour
estimation -> scene -> question answering -> HTTP response) runs without YOLO weights.
Real YOLO / Whisper / Piper need their packages and are NOT exercised here.
"""
import base64
import io
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import create_app  # noqa: E402
from config import Config  # noqa: E402
from modules.detector import Detection, HogPersonDetector  # noqa: E402


class FakeDetector:
    kind = "fake"

    def detect(self, bgr):
        return [
            Detection("laptop", 0.92, (20, 20, 140, 120)),
            Detection("bottle", 0.81, (200, 40, 260, 180)),
            Detection("cell phone", 0.77, (30, 150, 90, 220)),
        ]


def make_frame():
    img = np.full((240, 320, 3), 235, np.uint8)
    cv2.rectangle(img, (20, 20), (140, 120), (110, 110, 110), -1)   # gray laptop
    cv2.rectangle(img, (200, 40), (260, 180), (200, 80, 20), -1)    # blue bottle (BGR)
    cv2.rectangle(img, (30, 150), (90, 220), (20, 20, 20), -1)      # black phone
    return img


def jpeg(img=None):
    ok, buf = cv2.imencode(".jpg", make_frame() if img is None else img)
    assert ok
    return buf.tobytes()


@pytest.fixture()
def client():
    cfg = Config(offline=True, rate_limit_per_min=0)
    return create_app(cfg, detector=FakeDetector()).test_client()


def ask(client, question, **extra):
    return client.post("/vision/ask", data={"image": (io.BytesIO(jpeg()), "f.jpg"), "question": question, **extra})


# ----------------------------------------------------------------------------- status / basics
def test_status(client):
    r = client.get("/vision/status")
    assert r.status_code == 200
    j = r.get_json()
    assert j["name"] == "VISION" and j["detector"]["backend"] == "fake"
    assert j["voice"]["browser_fallback"] is True
    assert "api_key" not in str(j).lower()


def test_unknown_api_route_is_json_404(client):
    r = client.get("/vision/nope")
    assert r.status_code == 404 and r.get_json()["error"]["code"] == "not_found"


# ----------------------------------------------------------------------------- detect / analyze
def test_detect_multipart(client):
    r = client.post("/vision/detect", data={"image": (io.BytesIO(jpeg()), "f.jpg")})
    j = r.get_json()
    assert r.status_code == 200 and j["count"] == 3
    assert {o["label"] for o in j["objects"]} == {"laptop", "bottle", "cell phone"}
    assert all(0 <= o["confidence"] <= 1 for o in j["objects"])


def test_detect_json_dataurl(client):
    data_url = "data:image/jpeg;base64," + base64.b64encode(jpeg()).decode()
    r = client.post("/vision/detect", json={"image": data_url})
    assert r.status_code == 200 and r.get_json()["count"] == 3


def test_analyze_colours_and_summary(client):
    j = client.post("/vision/analyze", data={"image": (io.BytesIO(jpeg()), "f.jpg")}).get_json()
    colours = {o["label"]: o["color"]["name"] for o in j["objects"]}
    assert colours["bottle"] == "blue"
    assert colours["laptop"] == "gray"
    assert colours["cell phone"] == "black"
    assert "laptop" in j["summary"] and "mobile phone" in j["summary"]


# ----------------------------------------------------------------------------- ask (the key feature)
def test_ask_what_do_you_see(client):
    j = ask(client, "What can you see in front of me?").get_json()
    assert j["source"] == "vision-local"
    assert "laptop" in j["answer"] and "bottle" in j["answer"] and "mobile phone" in j["answer"]


def test_ask_count(client):
    assert "three" in ask(client, "How many objects can you detect?").get_json()["answer"]


def test_ask_colour_of_bottle(client):
    assert "blue" in ask(client, "What colour is the bottle?").get_json()["answer"]


def test_ask_absent_object_is_not_invented(client):
    a = ask(client, "Is there a car?").get_json()["answer"]
    assert a.startswith("No") and "car" in a
    assert "colour" in ask(client, "What colour is the car?").get_json()["answer"].lower()


def test_ask_presence_position_confidence(client):
    assert ask(client, "Can you see a laptop?").get_json()["answer"].startswith("Yes")
    assert "left" in ask(client, "Where is the laptop?").get_json()["answer"]
    assert "92%" in ask(client, "How confident are you?").get_json()["answer"]


def test_ask_follow_up_uses_offline_facts(client):
    a = ask(client, "What is a laptop used for?").get_json()
    assert a["source"] == "object-facts" and "programming" in a["answer"]


def test_ask_smalltalk(client):
    a = ask(client, "Hello").get_json()
    assert a["answer"] == "Hello! How can I help you?"


def test_ask_validation(client):
    assert client.post("/vision/ask", data={"question": "hi"}).status_code == 400            # no image
    r = client.post("/vision/ask", data={"image": (io.BytesIO(jpeg()), "f.jpg")})
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "missing_question"
    r = ask(client, "x" * 501)
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "question_too_long"
    assert ask(client, "hi", language="fr").status_code == 400
    assert ask(client, "hi", history="not json").status_code == 400
    assert ask(client, "hi", history='[{"role":"system","content":"x"}]').status_code == 400


def test_image_validation(client):
    assert client.post("/vision/detect", json={"image": "!!!notbase64"}).status_code == 400
    assert client.post("/vision/detect", json={"image": base64.b64encode(b"not an image").decode()}).status_code == 400
    assert client.post("/vision/detect", json={}).status_code == 400
    assert client.post("/vision/detect", data={"image": (io.BytesIO(b""), "e.jpg")}).status_code == 400


def test_upload_too_large():
    app = create_app(Config(offline=True, max_upload_mb=1, rate_limit_per_min=0), detector=FakeDetector())
    r = app.test_client().post("/vision/detect", data={"image": (io.BytesIO(b"0" * 2_000_000), "big.jpg")})
    assert r.status_code == 413


def test_empty_scene_is_honest():
    class Nothing:
        kind = "fake"

        def detect(self, _):
            return []

    c = create_app(Config(offline=True, rate_limit_per_min=0), detector=Nothing()).test_client()
    a = c.post("/vision/ask", data={"image": (io.BytesIO(jpeg()), "f.jpg"), "question": "What can you see?"}).get_json()["answer"]
    assert "can't identify" in a and "may be there" in a


# ----------------------------------------------------------------------------- chat / voice
def test_chat_without_camera(client):
    assert client.post("/chat", json={"message": "thank you"}).get_json()["answer"].startswith("You're welcome")
    assert client.post("/chat", json={"message": "what is a bottle used for"}).get_json()["source"] == "object-facts"
    assert client.post("/chat", json={"message": ""}).status_code == 400
    # hindi greeting is answered in hindi
    assert "नमस्ते" in client.post("/chat", json={"message": "namaste", "language": "hi"}).get_json()["answer"]


def test_chat_unknown_is_honest_fallback(client):
    j = client.post("/chat", json={"message": "blorp zibble"}).get_json()
    assert j["source"] == "fallback"


def test_chat_open_ended_query_reaches_llm_and_uses_selected_language(monkeypatch):
    from modules import chat as chat_module

    calls = {}
    monkeypatch.setattr(chat_module.llm, "provider", lambda _cfg: "openai")

    def complete(_cfg, messages, extra_system="", language="en", timeout=90):
        calls.update(messages=messages, extra_system=extra_system, language=language, timeout=timeout)
        return "यह एक उत्तर है।"

    monkeypatch.setattr(chat_module.llm, "complete", complete)
    app = create_app(Config(offline=False, rate_limit_per_min=0), detector=FakeDetector())
    response = app.test_client().post("/chat", json={
        "message": "Write a short explanation of gravity.",
        "history": [{"role": "user", "content": "Explain forces."}, {"role": "assistant", "content": "A force is a push or pull."}],
        "language": "hi",
    })

    assert response.status_code == 200
    assert response.get_json()["answer"] == "यह एक उत्तर है।"
    assert calls["language"] == "hi"
    assert calls["timeout"] == 90
    assert calls["messages"][-1]["content"] == "Write a short explanation of gravity."


def test_chat_provider_failure_is_retryable_json(monkeypatch):
    from modules import chat as chat_module, llm

    monkeypatch.setattr(chat_module.llm, "provider", lambda _cfg: "openai")

    def fail(*_args, **_kwargs):
        raise llm.LLMError("provider timeout")

    monkeypatch.setattr(chat_module.llm, "complete", fail)
    app = create_app(Config(offline=False, rate_limit_per_min=0), detector=FakeDetector())
    response = app.test_client().post("/chat", json={"message": "Write a poem about rain."})

    assert response.status_code == 502
    assert response.get_json()["error"]["code"] == "llm_unavailable"


def test_vision_open_ended_query_reaches_llm_with_camera_context(monkeypatch):
    from modules import chat as chat_module

    calls = {}
    monkeypatch.setattr(chat_module.llm, "provider", lambda _cfg: "openai")

    def complete(_cfg, messages, extra_system="", language="en", timeout=90):
        calls.update(messages=messages, extra_system=extra_system, language=language)
        return "The colors suggest a bright, playful scene."

    monkeypatch.setattr(chat_module.llm, "complete", complete)
    app = create_app(Config(offline=False, rate_limit_per_min=0), detector=FakeDetector())
    response = ask(app.test_client(), "What story do these colors tell?", language="en")

    assert response.status_code == 200
    assert response.get_json()["answer"] == "The colors suggest a bright, playful scene."
    assert "Camera context:" in calls["extra_system"]
    assert calls["messages"][-1]["content"] == "What story do these colors tell?"


def test_piper_uses_language_voice_and_utf8(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from modules import voice

    hindi_model = tmp_path / "hindi.onnx"
    calls = {}
    monkeypatch.setattr(voice, "_piper_cmd", lambda: ["piper"])
    monkeypatch.setattr(voice.os.path, "exists", lambda _path: True)

    def run(cmd, input, capture_output, timeout):
        calls.update(cmd=cmd, input=input, timeout=timeout)
        output = cmd[cmd.index("--output_file") + 1]
        Path(output).write_bytes(b"RIFFtest")
        return SimpleNamespace(returncode=0, stderr=b"")

    monkeypatch.setattr(voice.subprocess, "run", run)
    cfg = Config(piper_model="/default.onnx", piper_model_hi=str(hindi_model))
    wav = voice.synthesize(cfg, "नमस्ते ਪੰਜਾਬੀ", language="hi")

    assert calls["cmd"][calls["cmd"].index("--model") + 1] == str(hindi_model)
    assert calls["input"] == "नमस्ते ਪੰਜਾਬੀ".encode("utf-8")
    assert wav == b"RIFFtest"


def test_transcribe_unavailable_or_validation(client):
    assert client.post("/voice/transcribe", data={}).status_code == 400
    r = client.post("/voice/transcribe", data={"audio": (io.BytesIO(b"RIFFxxxx"), "a.wav")})
    from modules import voice
    if voice.stt_engine() is None:
        assert r.status_code == 503 and r.get_json()["error"]["fallback"] == "browser-speech-recognition"


def test_speak_validation_and_fallback(client):
    assert client.post("/voice/speak", json={}).status_code == 400
    assert client.post("/voice/speak", json={"text": "hi", "speed": 9}).status_code == 400
    r = client.post("/voice/speak", json={"text": "hello"})
    assert r.status_code == 501 and r.get_json()["error"]["fallback"] == "browser-speech-synthesis"


# ----------------------------------------------------------------------------- security
def test_token_auth_and_cors():
    cfg = Config(offline=True, api_token="s3cret", rate_limit_per_min=0, cors_origins=["https://app.example.com"])
    c = create_app(cfg, detector=FakeDetector()).test_client()
    assert c.get("/vision/status").status_code == 200  # status stays public (health checks)
    assert c.post("/chat", json={"message": "hi"}).status_code == 401
    assert c.post("/chat", json={"message": "hi"}, headers={"Authorization": "Bearer wrong"}).status_code == 401
    ok = c.post("/chat", json={"message": "hi"}, headers={"Authorization": "Bearer s3cret", "Origin": "https://app.example.com"})
    assert ok.status_code == 200 and ok.headers["Access-Control-Allow-Origin"] == "https://app.example.com"
    evil = c.get("/vision/status", headers={"Origin": "https://evil.example"})
    assert "Access-Control-Allow-Origin" not in evil.headers
    pre = c.options("/chat", headers={"Origin": "https://app.example.com"})
    assert pre.status_code == 204 and "POST" in pre.headers["Access-Control-Allow-Methods"]


def test_rate_limit():
    c = create_app(Config(offline=True, rate_limit_per_min=3), detector=FakeDetector()).test_client()
    codes = [c.post("/chat", json={"message": "hi"}).status_code for _ in range(5)]
    assert codes[:3] == [200, 200, 200] and codes[3:] == [429, 429]


def test_security_headers_and_no_store(client):
    r = client.get("/vision/status")
    assert r.headers["Cache-Control"] == "no-store" and r.headers["X-Content-Type-Options"] == "nosniff"
    assert "camera=(self)" in r.headers["Permissions-Policy"]


# ----------------------------------------------------------------------------- real OpenCV fallback detector
def test_hog_fallback_runs_and_finds_no_people_in_blank_frame():
    assert HogPersonDetector().detect(np.full((240, 320, 3), 200, np.uint8)) == []
