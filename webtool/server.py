"""Servidor Flask del motor visual de etiquetado (Fase 0, soporte de validación).

Sirve frames de video, landmarks de MediaPipe y persiste anotaciones a JSON.
Arranca con: ./venv/bin/python -m webtool.server
"""
from __future__ import annotations

import os

import cv2
from flask import Flask, Response, abort, jsonify, send_from_directory
from webtool.frames import FrameReader

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


def video_path(video: str) -> str:
    """Path seguro a un video de data/raw/, o 404 si no existe."""
    if "/" in video or "\\" in video or not video.lower().endswith(VIDEO_EXTS):
        abort(404)
    path = os.path.join(RAW_DIR, video)
    if not os.path.isfile(path):
        abort(404)
    return path


def landmarks_npy_path(video: str) -> str:
    stem = os.path.splitext(video)[0]
    return os.path.join(OUTPUT_DIR, f"{stem}_landmarks.npy")


def read_meta(path: str) -> dict:
    cap = cv2.VideoCapture(path)
    try:
        if not cap.isOpened():
            abort(404)
        cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        ok, frame = cap.read()  # dims reales tras auto-orientación
        if ok:
            height, width = frame.shape[:2]
        else:
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    finally:
        cap.release()
    return {"fps": fps, "n_frames": n_frames, "width": width, "height": height}


def create_app() -> Flask:
    app = Flask(__name__, static_folder=None)

    reader = FrameReader()

    @app.get("/api/frame/<video>/<int:n>")
    def api_frame(video: str, n: int):
        path = video_path(video)
        jpeg = reader.get_jpeg(path, n)
        return Response(jpeg, mimetype="image/jpeg")

    @app.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    @app.get("/static/<path:filename>")
    def static_files(filename: str):
        return send_from_directory(STATIC_DIR, filename)

    @app.get("/api/videos")
    def api_videos():
        return jsonify(videos=list_videos())

    @app.get("/api/meta/<video>")
    def api_meta(video: str):
        path = video_path(video)
        meta = read_meta(path)
        meta["has_landmarks"] = os.path.isfile(landmarks_npy_path(video))
        return jsonify(meta)

    return app


if __name__ == "__main__":
    create_app().run(host="127.0.0.1", port=5000, debug=True)
