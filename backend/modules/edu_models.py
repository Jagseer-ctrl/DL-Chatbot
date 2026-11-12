"""Educational neural models (PyTorch, optional).

  * IntentNet  - RNN or LSTM text classifier (greeting / thanks / goodbye / identity / capabilities / other).
                 Used by the chat router for small talk. `--cell rnn` vs `--cell lstm` lets you compare them.
  * SmallCNN   - tiny CNN trained on CIFAR-10 (32x32). Separate from YOLO: YOLO is the practical detector,
                 this is the "see how a CNN works" model. Exposed at POST /vision/classify.

Train from backend/:
    python -m modules.edu_models train-intent --cell lstm
    python -m modules.edu_models train-cnn --epochs 5        # downloads CIFAR-10 (~170 MB) once

If torch or the weight files are missing the app simply skips these models (status shows it).
These were written fresh for this project; if you have your own earlier RNN/LSTM/CNN code, swap it in
behind the same `predict()` / `classify()` methods.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
from pathlib import Path

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
CIFAR_CLASSES = ["airplane", "automobile", "bird", "cat", "deer", "dog", "frog", "horse", "ship", "truck"]

INTENT_DATA = {
    "greeting": ["hello", "hi", "hey", "hey there", "good morning", "good evening", "namaste", "hello vision", "hi vision",
                 "sat sri akal", "hey vision", "good afternoon", "howdy", "hi there", "hello there"],
    "thanks": ["thanks", "thank you", "thank you so much", "thanks a lot", "that helps thanks", "great thanks",
               "thanks vision", "appreciate it", "cheers", "thank you vision"],
    "goodbye": ["bye", "goodbye", "see you", "see you later", "good night", "talk to you later", "bye vision",
                "that is all", "stop listening", "i am done"],
    "identity": ["who are you", "what is your name", "what are you", "tell me about yourself", "introduce yourself",
                 "are you a robot", "what should i call you", "are you an ai"],
    "capabilities": ["what can you do", "how can you help me", "what are your features", "help me", "what do you do",
                     "can you see", "how do you work", "what can you help with"],
    "other": ["what is a laptop used for", "how many objects do you see", "what colour is the bottle", "who invented the telephone",
              "explain photosynthesis", "what is the capital of france", "where is the bottle", "tell me about neural networks",
              "describe the room", "how tall is mount everest", "what is a cnn", "is there a chair", "count the books",
              "what is machine learning", "what time is it in tokyo", "define gravity"],
}


def torch_available() -> bool:
    return importlib.util.find_spec("torch") is not None


def _tok(text: str) -> list[str]:
    return re.findall(r"\w+", text.lower())


# --------------------------------------------------------------------------- intent RNN / LSTM
def _build_intent_net(vocab: int, classes: int, cell: str):
    import torch.nn as nn

    class IntentNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.emb = nn.Embedding(vocab, 32, padding_idx=0)
            rnn = nn.LSTM if cell == "lstm" else nn.RNN
            self.rnn = rnn(32, 64, batch_first=True)
            self.out = nn.Linear(64, classes)

        def forward(self, x):
            h, _ = self.rnn(self.emb(x))
            mask = (x != 0).unsqueeze(-1)
            last = (h * mask).sum(1) / mask.sum(1).clamp(min=1)  # mean over real tokens
            return self.out(last)

    return IntentNet()


def train_intent(cell: str = "lstm", epochs: int = 300) -> Path:
    import torch
    import torch.nn.functional as F

    labels = list(INTENT_DATA)
    vocab = {"<pad>": 0, "<unk>": 1}
    for sents in INTENT_DATA.values():
        for s in sents:
            for w in _tok(s):
                vocab.setdefault(w, len(vocab))
    pairs = [(s, labels.index(l)) for l, ss in INTENT_DATA.items() for s in ss]
    maxlen = max(len(_tok(s)) for s, _ in pairs)

    def enc(text):
        ids = [vocab.get(w, 1) for w in _tok(text)][:maxlen]
        return ids + [0] * (maxlen - len(ids))

    x = torch.tensor([enc(s) for s, _ in pairs])
    y = torch.tensor([l for _, l in pairs])
    torch.manual_seed(0)
    net = _build_intent_net(len(vocab), len(labels), cell)
    opt = torch.optim.Adam(net.parameters(), lr=0.01)
    for ep in range(epochs):
        opt.zero_grad()
        loss = F.cross_entropy(net(x), y)
        loss.backward()
        opt.step()
        if ep % 50 == 0 or ep == epochs - 1:
            acc = (net(x).argmax(1) == y).float().mean().item()
            print(f"[{cell}] epoch {ep:3d} loss {loss.item():.4f} train-acc {acc:.2%}")
    MODELS_DIR.mkdir(exist_ok=True)
    path = MODELS_DIR / "intent.pt"
    torch.save({"state": net.state_dict(), "vocab": vocab, "labels": labels, "cell": cell, "maxlen": maxlen}, path)
    print("saved", path)
    return path


class IntentModel:
    def __init__(self, ckpt: dict):
        import torch

        self.vocab, self.labels, self.maxlen, self.cell = ckpt["vocab"], ckpt["labels"], ckpt["maxlen"], ckpt["cell"]
        self.net = _build_intent_net(len(self.vocab), len(self.labels), self.cell)
        self.net.load_state_dict(ckpt["state"])
        self.net.eval()
        self._torch = torch

    @classmethod
    def load(cls):
        path = MODELS_DIR / "intent.pt"
        if not torch_available() or not path.exists():
            return None
        import torch

        try:
            return cls(torch.load(path, map_location="cpu"))
        except Exception:
            return None

    def predict(self, text: str) -> tuple[str, float]:
        ids = [self.vocab.get(w, 1) for w in _tok(text)][: self.maxlen]
        if not ids:
            return "other", 0.0
        ids += [0] * (self.maxlen - len(ids))
        with self._torch.no_grad():
            probs = self._torch.softmax(self.net(self._torch.tensor([ids])), dim=1)[0]
        i = int(probs.argmax())
        return self.labels[i], float(probs[i])


# --------------------------------------------------------------------------- CNN
def _build_cnn():
    import torch.nn as nn

    return nn.Sequential(
        nn.Conv2d(3, 32, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
        nn.Conv2d(32, 64, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
        nn.Conv2d(64, 128, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
        nn.Flatten(), nn.Dropout(0.3), nn.Linear(128 * 4 * 4, 128), nn.ReLU(), nn.Linear(128, 10),
    )


def train_cnn(epochs: int = 5) -> Path:
    import torch
    import torchvision
    import torchvision.transforms as T

    tf = T.Compose([T.ToTensor(), T.Normalize((0.5,) * 3, (0.5,) * 3)])
    root = MODELS_DIR / "cifar10"
    train = torchvision.datasets.CIFAR10(root, train=True, download=True, transform=tf)
    test = torchvision.datasets.CIFAR10(root, train=False, download=True, transform=tf)
    tl = torch.utils.data.DataLoader(train, batch_size=128, shuffle=True)
    vl = torch.utils.data.DataLoader(test, batch_size=256)
    net = _build_cnn()
    opt = torch.optim.Adam(net.parameters(), lr=1e-3)
    for ep in range(epochs):
        net.train()
        for xb, yb in tl:
            opt.zero_grad()
            torch.nn.functional.cross_entropy(net(xb), yb).backward()
            opt.step()
        net.eval()
        with torch.no_grad():
            correct = sum((net(xb).argmax(1) == yb).sum().item() for xb, yb in vl)
        print(f"epoch {ep + 1}/{epochs} test-acc {correct / len(test):.2%}")
    path = MODELS_DIR / "cnn_cifar10.pt"
    torch.save(net.state_dict(), path)
    print("saved", path)
    return path


class CnnClassifier:
    def __init__(self, state):
        import torch

        self.net = _build_cnn()
        self.net.load_state_dict(state)
        self.net.eval()
        self._torch = torch

    @classmethod
    def load(cls):
        path = MODELS_DIR / "cnn_cifar10.pt"
        if not torch_available() or not path.exists():
            return None
        import torch

        try:
            return cls(torch.load(path, map_location="cpu"))
        except Exception:
            return None

    def classify(self, bgr, top: int = 3) -> list[dict]:
        import cv2
        import numpy as np

        rgb = cv2.cvtColor(cv2.resize(bgr, (32, 32), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
        t = self._torch.from_numpy(((rgb.astype(np.float32) / 255.0) - 0.5) / 0.5).permute(2, 0, 1).unsqueeze(0)
        with self._torch.no_grad():
            p = self._torch.softmax(self.net(t), dim=1)[0]
        idx = p.argsort(descending=True)[:top]
        return [{"label": CIFAR_CLASSES[int(i)], "confidence": round(float(p[i]), 3)} for i in idx]


def status() -> dict:
    return {
        "torch": torch_available(),
        "intent_model": (MODELS_DIR / "intent.pt").exists(),
        "cnn_model": (MODELS_DIR / "cnn_cifar10.pt").exists(),
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("train-intent")
    a.add_argument("--cell", choices=["rnn", "lstm"], default="lstm")
    a.add_argument("--epochs", type=int, default=300)
    b = sub.add_parser("train-cnn")
    b.add_argument("--epochs", type=int, default=5)
    args = ap.parse_args()
    if not torch_available():
        raise SystemExit("PyTorch is not installed: pip install -r requirements-ml.txt")
    if args.cmd == "train-intent":
        train_intent(args.cell, args.epochs)
    else:
        train_cnn(args.epochs)
    print(json.dumps(status()))
