# VISION — voice + camera AI assistant

One codebase, two ways to run it:

| | **Desktop app** | **Web app** |
|---|---|---|
| Shell | Electron | Any modern browser |
| Frontend | the shared React app | the shared React app |
| Backend | Flask, started and stopped for you on `127.0.0.1` | the same Flask app, local or deployed |
| Camera / mic | macOS permission prompts (separate for each) | browser permission prompts (HTTPS required when deployed) |
| Offline | YOLO + Whisper + local answers | depends on the backend you point it at |

```
vision/
├── backend/            Python Flask API (shared by desktop + web)
│   ├── app.py          all endpoints, validation, CORS, auth, rate limit, serves the built UI
│   ├── wsgi.py         production entry (gunicorn)
│   ├── modules/        detector (YOLO / OpenCV fallback) · colors · vqa · chat · llm · knowledge (RAG) · voice · edu_models (RNN/LSTM/CNN)
│   └── tests/          pytest suite
├── frontend/           React + Vite + Framer Motion (orb, voice, camera, chat, settings)
├── desktop/            Electron shell (main.js, preload.js, macOS entitlements)
├── deploy/Caddyfile    automatic HTTPS reverse proxy
├── scripts/setup_mac.sh
├── Dockerfile · docker-compose.yml
└── .env.example
```

---

## 1. Install on macOS (recommended path)

Prerequisites: macOS, [Homebrew](https://brew.sh), ~3 GB free disk (PyTorch is large).

```bash
cd vision
./scripts/setup_mac.sh --full     # Python 3.11 venv, YOLO + PyTorch, Whisper, npm deps, tests
```

`--full` = YOLO/PyTorch + offline Whisper speech-to-text. Use `--core` for a tiny install (API + OpenCV *people-only* detector) or no flag for YOLO without Whisper.

Manual equivalent:

```bash
brew install python@3.11 node
python3.11 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements-ml.txt -r backend/requirements-voice.txt
(cd backend && .venv/bin/python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')")   # one-time weight download
(cd backend && .venv/bin/python -m modules.edu_models train-intent --cell lstm)           # optional, seconds
cp .env.example .env
npm run setup                     # installs frontend + desktop deps
```

## 2. Run it

| Goal | Command | Opens |
|---|---|---|
| **Web app** (one server, UI + API) | `npm run start:web` | http://localhost:5001 |
| **Desktop app** | `npm run desktop` | Electron window (backend starts/stops automatically) |
| Dev, web, hot reload | `npm run dev:backend` and `npm run dev:web` (two terminals) | http://localhost:5173 |
| Dev, desktop | `npm run dev:web` in one terminal, then `npm run desktop:dev` in another (Electron starts the backend itself and loads Vite) | Electron window on http://127.0.0.1:5173 |
| Tests | `npm run test:backend` | |

Port 5001 is deliberate: macOS AirPlay Receiver occupies 5000.

**Desktop speech note:** Electron has no Web Speech service, so the desktop app uses the backend’s Whisper (`requirements-voice.txt`). Without it, typing still works and VISION tells you why the mic is unavailable.

**Desktop → remote backend:** `VISION_REMOTE_BACKEND=https://vision.example.com npm run desktop` (no Python needed on the Mac). Add `http://127.0.0.1:5174` to the server’s `VISION_CORS_ORIGINS`. The UI then shows a “Remote backend” badge because frames/audio leave the machine.

## 3. VS Code

1. `code .` in `vision/`, accept the recommended extensions (Python, ESLint, Prettier).
2. Command Palette → *Python: Select Interpreter* → `backend/.venv/bin/python`.
3. **Run and Debug** → *Backend + Web (Chrome)* launches Flask under the debugger plus Chrome on :5173 (run the *dev: web (Vite)* task first). *pytest* runs the test suite with breakpoints.
4. **Terminal → Run Task…** has `dev: backend`, `dev: web (Vite)`, `dev: desktop`, `test: backend`, `build: web`.

## 4. Using VISION

* **Mic button** → speak one question; the mic closes after the answer (turn on *Continuous* to keep going).
* **Wake word** toggle → the mic opens and stays on (red indicator) waiting for “Hey Vision”. Say it alone to get “Hello! How can I help you?”, or with a question (“Hey Vision, what can you see?”).
* **Camera button / Start camera** → live preview, bounding boxes, count and confidence. *Capture & analyse* asks “what can you see?” on a fresh frame; *Live detection* refreshes boxes ~1×/s.
* With the camera on, every question carries the current frame: *“What can you see?” → “What colour is the bottle?” → “How many objects?” → “Where is the laptop?” → “What is a laptop used for?”*
* **Stop assistant** (and ⌘⇧. on desktop) instantly stops mic, camera, speech and any in-flight request.
* **Settings**: language (English / हिन्दी / ਪੰਜਾਬੀ), STT engine, TTS engine, voice, speed, mute, backend status.

### Orb states
Idle (floating blue-purple) · Listening (swells with mic level via Web Audio) · Thinking (rotating liquid rings, SVG turbulence filter) · Speaking (waveform) · Camera active (scan line + glowing halo).

## 5. How questions are answered

1. Small talk → LSTM/RNN intent model if trained (`train-intent --cell rnn|lstm` to compare), else keyword rules.
2. **Camera questions in English** (count / list / colour / position / presence / confidence) are answered **deterministically from the detector output** — exact, offline, can’t hallucinate.
3. Everything else → **LLM** if `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set on the backend, with the camera context block and (for factual questions) **Wikipedia RAG** text. Hindi/Punjabi answers use this path.
4. No LLM: built-in object facts → Wikipedia lookup → honest “I’m not sure”.

Uncertainty rules: detections under 50 % are described as “might”; an empty result says the model only knows a fixed set of objects; colour is called an estimate; the detector label list is 80 COCO classes, so VISION never names things outside it.

## 6. API reference

All JSON errors look like `{"error": {"code": "...", "message": "..."}}`.

| Endpoint | Input | Output |
|---|---|---|
| `GET /vision/status` | – | detector backend, voice engines, LLM/RAG flags (never keys) |
| `POST /voice/transcribe` | multipart `audio` (WAV/any ffmpeg-readable), `language` en/hi/pa | `{text, language, engine}` · 503 if no Whisper |
| `POST /voice/speak` | `{text ≤1000, speed 0.5–2, language}` | `audio/wav` · 501 + `fallback` if Piper isn’t configured (UI then uses browser voices) |
| `POST /vision/detect` | `image` (multipart file or JSON base64/data-URL) | boxes, labels, confidence, count |
| `POST /vision/analyze` | `image` | detect + positions + colours + spoken summary |
| `POST /vision/ask` | `image`, `question ≤500`, `language`, `history` | answer + source + scene |
| `POST /vision/classify` | `image`, optional `box` | CIFAR-10 CNN top-3 (educational; needs `train-cnn`) |
| `POST /chat` | `{message, history, language}` | answer (no camera) |

Limits: 12 MB uploads, images downscaled to 1280 px, 120 requests/min/IP, history ≤ 20 items.

Example:
```bash
curl -F image=@frame.jpg -F "question=How many objects can you detect?" http://localhost:5001/vision/ask
```

## 7. Privacy & security (what is actually enforced)

* Camera starts only from a button press; the microphone is requested separately; the OS/browser prompts for each. Red “on” indicators are shown for both; *Stop* controls are always visible.
* Frames and audio are processed **in memory** and never written to disk or logged by the backend (Whisper via `faster-whisper` reads from a memory buffer). Chat history is not persisted; only UI preferences go to `localStorage`.
* No face recognition; people are detected only as “person”.
* Frames are analysed locally when the backend is local. If the backend is remote, a visible badge/warning says frames and audio are sent there.
* API keys live only in the backend environment. CORS allow-list, optional bearer token, rate limiting, upload caps, `Permissions-Policy`, `nosniff`, `no-store` are on by default. Deployed access needs HTTPS (Caddy config included).
* **Be aware:** with the *browser* speech engine, Chrome/Edge/Safari send microphone audio to their vendor’s recognition service. Choose *Backend Whisper* for fully on-device recognition. In wake-word mode the mic is open and all speech is transcribed, but anything without “Hey Vision” is discarded and never answered or stored.

## 8. Production deployment

```bash
echo "VISION_DOMAIN=vision.example.com" >> .env      # DNS A record must point at the server
# add ANTHROPIC_API_KEY=... etc. to .env
docker compose up -d --build                         # VISION + Caddy with automatic HTTPS
```

* Build variants: `--build-arg INSTALL_ML=0` (slim, people-only), `--build-arg INSTALL_VOICE=1` (+Whisper).
* One gunicorn worker on purpose (models are big); concurrency via threads. CPU inference of YOLOv8n is fine for ~1 fps/user; use a GPU host or a smaller `VISION_CONFIDENCE`/frame rate for many users.
* Public site: a bearer token in a browser bundle isn’t secret — add `basicauth` in `deploy/Caddyfile` or put it behind your login, and keep rate limiting on.
* Without Docker: `cd backend && gunicorn -w 1 --threads 4 -b 127.0.0.1:5001 wsgi:app` behind nginx/Caddy with TLS, after `npm run build:web` (Flask serves `frontend/dist`).
* Split hosting (UI on a CDN, API elsewhere): build with `VITE_API_URL=https://api.example.com` and add the UI origin to `VISION_CORS_ORIGINS`.
* macOS installer: `npm run dist:mac` builds a `.dmg` (bundles backend source + UI; the Mac still needs the Python venv — place it at `~/Library/Application Support/VISION/venv` or set `VISION_PYTHON`). Distribution outside your own machine needs Apple signing/notarisation.

## 9. Testing status — read this

**Verified in the build environment**

* `pytest` — 24 tests passing: full pipeline (image decode → detection → colour estimate → scene → question answering → HTTP), validation errors, upload limit, CORS, bearer auth, rate limit, security headers, honest empty-scene answers, Hindi greeting, voice fallbacks, real OpenCV HOG detector.
* Live server process over HTTP: status, upload → detect/ask, chat, static serving + SPA fallback, path-traversal attempt, error JSON.
* Frontend: all `.js/.jsx` parse cleanly; the WAV encoder was run and produces a valid 16 kHz mono PCM file; the “Hey Vision” matcher was run against positive and negative phrases.
* Electron `main.js` / `preload.js` pass `node --check`.

**NOT verified here — I could not run these (no package installs, no camera, microphone, display or macOS in the sandbox)**

* YOLO detection (the tests use a scripted detector; only the OpenCV people-only fallback ran for real), Whisper, Piper, and the PyTorch RNN/LSTM/CNN training/inference.
* `npm install`, the Vite build, the React UI in a real browser, the actual camera/mic/Web Speech/Web Audio behaviour and the animations.
* Launching Electron, macOS permission prompts, the `.dmg` build, Docker build, `setup_mac.sh`.

Please run this checklist once (≈10 min) on your Mac, in **both** modes:

1. `npm run test:backend` → all green.
2. Web: `npm run start:web` → open http://localhost:5001. Status in *Settings* shows detector `yolo`.
3. Click **Start camera** → permission prompt → boxes appear with *Live detection* on.
4. Hold up a phone/bottle/laptop → ask “What can you see?”, “How many objects?”, “What colour is the bottle?” (typed first, then by voice).
5. Mic button → speak → answer is spoken. Try Hindi and Punjabi (answers beyond the built-ins need an LLM key; speech output needs an installed voice).
6. Turn on **Wake word** → say “Hey Vision” → greeting; then a question.
7. **Stop assistant** → red indicators vanish and the camera light turns off.
8. Desktop: `npm run desktop` → macOS asks camera and microphone separately → repeat steps 3–7; quit the app and confirm `lsof -i :5001` shows nothing.

## 10. Known limitations / decisions

* **Wake word:** I did not use openWakeWord or Porcupine. Neither ships a ready “Hey Vision” model (both need a custom-trained keyword — Porcupine also needs an access key), so wake detection is done on the transcript from whichever speech engine is active. That is accurate enough for a demo but heavier and less private than a dedicated on-device keyword spotter; swapping one in means feeding `onSpeech()` in `App.jsx` from its callback.
* **RNN/LSTM/CNN:** your earlier chatbot code wasn’t in this conversation, so `modules/edu_models.py` is new: a small RNN/LSTM intent classifier and a CIFAR-10 CNN. Plug your own models in behind `IntentModel.predict()` / `CnnClassifier.classify()`.
* **Speaking waveform:** with browser voices the browser exposes no audio stream, so the waveform is driven by word-boundary events; with Piper it follows the real audio.
* **Colours** come from a simple HSV estimate of the object’s centre; background and lighting affect it.
* **Hindi/Punjabi:** recognition works via the browser engine or Whisper; deterministic camera answers are English-only; other answers in those languages need an LLM key; speech output requires an installed OS/browser voice (Punjabi voices are rare — VISION warns when none exists).
* Safari’s support for SVG filters on HTML elements is partial; the orb degrades to a smooth gradient there.

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| Banner “Cannot reach the VISION backend” | start it (`npm run dev:backend`); the UI retries every 3 s |
| Detector shows `hog-person-only` | `pip install -r backend/requirements-ml.txt` and ensure `yolov8n.pt` downloaded (needs internet once) |
| Mic button says speech recognition unavailable | Desktop: install `requirements-voice.txt`. Browser: use Chrome/Edge/Safari or set engine to Backend |
| “Network” error from browser STT | browser STT needs internet → switch to *Backend Whisper* |
| Camera/mic denied | macOS *System Settings → Privacy & Security → Camera/Microphone* → enable your browser or Electron |
| Camera blocked on a deployed site | it must be served over HTTPS |
| Port 5001 busy | set `VISION_PORT` (desktop picks a free port automatically) |
# DL-Chatbot
