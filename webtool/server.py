"""Servidor Flask del motor visual de etiquetado (Fase 0, soporte de validación).

Sirve frames de video, landmarks de MediaPipe y persiste anotaciones a JSON.
Arranca con: ./venv/bin/python -m webtool.server
"""
from __future__ import annotations

import os

from flask import Flask, jsonify, send_from_directory

RAW_DIR = "data/raw"
OUTPUT_DIR = "data/output"
VIDEO_EXTS = (".mov", ".mp4", ".avi", ".mkv")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


def list_videos() -> list[str]:
    if not os.path.isdir(RAW_DIR):
        return []
    return sorted(
        f for f in os.listdir(RAW_DIR) if f.lower().endswith(VIDEO_EXTS)
    )


def create_app() -> Flask:
    app = Flask(__name__, static_folder=None)

    @app.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    @app.get("/static/<path:filename>")
    def static_files(filename: str):
        return send_from_directory(STATIC_DIR, filename)

    @app.get("/api/videos")
    def api_videos():
        return jsonify(videos=list_videos())

    return app


if __name__ == "__main__":
    create_app().run(host="127.0.0.1", port=5000, debug=True)
