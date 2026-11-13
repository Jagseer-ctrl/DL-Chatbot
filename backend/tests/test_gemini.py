"""Tests for Google Gemini integration, /api/chat, and multimodal vision."""
import io
from pathlib import Path
import sys

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import create_app
from config import Config
from modules.detector import Detection


class FakeDetector:
    kind = "fake"

    def detect(self, bgr):
        return [Detection("laptop", 0.95, (10, 10, 100, 100))]


def test_health():
    app = create_app(Config(offline=True), detector=FakeDetector())
    res = app.test_client().get("/health")
    assert res.status_code == 200
    assert res.get_json() == {"ok": True}


def test_status_reports_gemini():
    cfg = Config(gemini_api_key="test-key", gemini_model="gemini-2.5-flash")
    app = create_app(cfg, detector=FakeDetector())
    res = app.test_client().get("/vision/status")
    assert res.status_code == 200
    data = res.get_json()
    assert data["llm"]["configured"] is True
    assert data["llm"]["provider"] == "gemini"
    assert data["llm"]["model"] == "gemini-2.5-flash"


def test_missing_api_key_returns_guidance():
    # Without Gemini API key
    cfg = Config(offline=False, gemini_api_key="", anthropic_api_key="", openai_api_key="")
    app = create_app(cfg, detector=FakeDetector())
    client = app.test_client()

    # Open-ended question
    res = client.post("/api/chat", json={"message": "Explain artificial intelligence."})
    assert res.status_code == 200
    j = res.get_json()
    assert "GEMINI_API_KEY" in j["reply"]


def test_gemini_chat_scenarios(monkeypatch):
    from modules import chat as chat_module

    responses = {
        "Hello": "Hello! I am VISION, your AI desk assistant powered by Gemini. How may I assist you today?",
        "Explain artificial intelligence.": "Artificial Intelligence is the simulation of human intelligence by machines...",
        "Explain CNN and RNN.": "CNNs (Convolutional Neural Networks) excel at spatial patterns like images. RNNs (Recurrent Neural Networks) process sequential data like text...",
        "Write a Python program.": "```python\ndef greet(name):\n    return f'Hello, {name}!'\n```",
        "Explain machine learning.": "Machine learning is a subset of AI where models learn patterns from data rather than explicit rule programming.",
        "Can you summarize our previous discussion?": "You previously asked about machine learning and neural architectures.",
    }

    recorded = []

    def mock_complete(cfg, messages, extra_system="", language="en", image_bytes=None, **kwargs):
        last_msg = messages[-1]["content"]
        recorded.append({"messages": messages, "image_bytes": image_bytes, "extra_system": extra_system})
        return responses.get(last_msg, f"Gemini response to: {last_msg}")

    monkeypatch.setattr(chat_module.llm, "complete", mock_complete)
    cfg = Config(gemini_api_key="valid-test-key", gemini_model="gemini-2.5-flash")
    app = create_app(cfg, detector=FakeDetector())
    client = app.test_client()

    # Scenario 1: Hello
    r1 = client.post("/api/chat", json={"message": "Hello"})
    assert r1.status_code == 200
    assert "VISION" in r1.get_json()["reply"]

    # Scenario 2: Explain artificial intelligence
    r2 = client.post("/api/chat", json={"message": "Explain artificial intelligence."})
    assert r2.status_code == 200
    assert "simulation of human intelligence" in r2.get_json()["reply"]

    # Scenario 3: Explain CNN and RNN
    r3 = client.post("/api/chat", json={"message": "Explain CNN and RNN."})
    assert r3.status_code == 200
    assert "CNN" in r3.get_json()["reply"] and "RNN" in r3.get_json()["reply"]

    # Scenario 4: Write a Python program
    r4 = client.post("/api/chat", json={"message": "Write a Python program."})
    assert r4.status_code == 200
    assert "def greet" in r4.get_json()["reply"]

    # Scenario 5: Explain machine learning
    r5 = client.post("/api/chat", json={"message": "Explain machine learning."})
    assert r5.status_code == 200
    assert "Machine learning" in r5.get_json()["reply"]

    # Scenario 6: Follow-up question with history
    hist = [
        {"role": "user", "content": "Explain machine learning."},
        {"role": "assistant", "content": "Machine learning is a subset of AI..."},
    ]
    r6 = client.post("/api/chat", json={
        "message": "Can you summarize our previous discussion?",
        "history": hist,
    })
    assert r6.status_code == 200
    assert len(recorded[-1]["messages"]) == 3
    assert recorded[-1]["messages"][0]["content"] == "Explain machine learning."


def test_gemini_multimodal_vision(monkeypatch):
    from modules import chat as chat_module

    received_images = []

    def mock_complete(cfg, messages, extra_system="", language="en", image_bytes=None, **kwargs):
        if image_bytes:
            received_images.append(image_bytes)
        return "I see a laptop on a wooden desk."

    monkeypatch.setattr(chat_module.llm, "complete", mock_complete)
    cfg = Config(gemini_api_key="valid-test-key", gemini_model="gemini-2.5-flash")
    app = create_app(cfg, detector=FakeDetector())
    client = app.test_client()

    img = np.full((120, 160, 3), 100, np.uint8)
    ok, buf = cv2.imencode(".jpg", img)
    assert ok

    res = client.post("/vision/ask", data={
        "image": (io.BytesIO(buf.tobytes()), "frame.jpg"),
        "question": "What is in front of me?",
    })
    assert res.status_code == 200
    assert res.get_json()["answer"] == "I see a laptop on a wooden desk."
    assert len(received_images) == 1

