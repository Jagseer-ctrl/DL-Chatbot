#!/usr/bin/env bash
# One-shot macOS setup for VISION.
#   ./scripts/setup_mac.sh            -> core + ML (YOLO, PyTorch)      [default]
#   ./scripts/setup_mac.sh --full     -> ML + offline Whisper speech-to-text
#   ./scripts/setup_mac.sh --core     -> API only with the OpenCV people-only fallback detector
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="ml"
[[ "${1:-}" == "--full" ]] && MODE="full"
[[ "${1:-}" == "--core" ]] && MODE="core"

command -v brew >/dev/null || { echo "Homebrew is required: https://brew.sh"; exit 1; }
brew list python@3.11 >/dev/null 2>&1 || brew install python@3.11
brew list node >/dev/null 2>&1 || brew install node

PY="$(brew --prefix python@3.11)/bin/python3.11"
echo "==> Creating backend/.venv with $($PY --version)"
"$PY" -m venv backend/.venv
backend/.venv/bin/python -m pip install --upgrade pip

case "$MODE" in
  core) REQ=requirements.txt ;;
  ml)   REQ=requirements-ml.txt ;;
  full) REQ=requirements-ml.txt ;;
esac
echo "==> Installing backend/$REQ"
backend/.venv/bin/pip install -r "backend/$REQ"
if [[ "$MODE" == "full" ]]; then
  echo "==> Installing offline speech-to-text (faster-whisper)"
  backend/.venv/bin/pip install -r backend/requirements-voice.txt
fi

if [[ "$MODE" != "core" ]]; then
  echo "==> Downloading YOLOv8n weights (one-time, needs internet)"
  (cd backend && .venv/bin/python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')")
  echo "==> Training the educational LSTM intent model (a few seconds)"
  (cd backend && .venv/bin/python -m modules.edu_models train-intent --cell lstm)
fi

[[ -f .env ]] || { cp .env.example .env; echo "==> Created .env (add API keys there if you want an LLM)"; }

echo "==> Installing frontend + desktop dependencies"
npm --prefix frontend install
npm --prefix desktop install

echo "==> Running backend tests"
(cd backend && .venv/bin/python -m pytest -q)

cat <<'EOF'

Done. Next:
  Web app (one server on http://localhost:5001):   npm run start:web
  Desktop app (Electron):                           npm run desktop
  Development (hot reload):                         npm run dev:backend   +   npm run dev:web   (http://localhost:5173)
EOF
