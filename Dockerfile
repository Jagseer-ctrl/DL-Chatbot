# VISION production image: React build + Flask/gunicorn backend in one container.
#   docker build -t vision .                         # with YOLO + PyTorch (CPU)
#   docker build -t vision --build-arg INSTALL_ML=0 . # slim: OpenCV people-only fallback
#   docker build -t vision --build-arg INSTALL_VOICE=1 .  # + Whisper speech-to-text
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.11-slim
ARG INSTALL_ML=1
ARG INSTALL_VOICE=0
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/requirements*.txt ./
RUN pip install -r requirements.txt \
 && if [ "$INSTALL_ML" = "1" ]; then \
      pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu \
   && pip install ultralytics; fi \
 && if [ "$INSTALL_VOICE" = "1" ]; then pip install faster-whisper; fi
COPY backend/ ./
RUN if [ "$INSTALL_ML" = "1" ]; then \
      python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')" \
   && python -m modules.edu_models train-intent --cell lstm; fi
COPY --from=web /web/dist /app/frontend/dist
RUN useradd -m vision && chown -R vision /app
USER vision
ENV VISION_HOST=0.0.0.0 VISION_PORT=5001 VISION_SERVE_FRONTEND=/app/frontend/dist \
    VISION_YOLO_WEIGHTS=/app/backend/yolov8n.pt VISION_TRUST_PROXY=1
EXPOSE 5001
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:5001/health')"
# One worker on purpose: each worker would load its own copy of YOLO/Whisper.
CMD ["gunicorn", "-w", "1", "--threads", "4", "--timeout", "120", "-b", "0.0.0.0:5001", "wsgi:app"]
