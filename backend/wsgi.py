"""Production entry point:  gunicorn -w 1 --threads 4 -b 0.0.0.0:5001 wsgi:app

Use ONE worker: the YOLO/Whisper models are large and each worker would load its own copy.
Concurrency comes from threads.
"""
import logging

from app import create_app

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
app = create_app(warmup=True)
