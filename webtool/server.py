"""Servidor Flask del motor visual de etiquetado (Fase 0, soporte de validación).

Sirve frames de video, landmarks de MediaPipe y persiste anotaciones a JSON.
Arranca con: ./venv/bin/python -m webtool.server
"""
from __future__ import annotations

import json
import math
import os

import cv2
import numpy as np
from flask import Flask, Response, abort, jsonify, request, send_from_directory
from webtool.frames import FrameReader
from src import pose

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


def annotations_path(video: str) -> str:
    stem = os.path.splitext(video)[0]
    return os.path.join(OUTPUT_DIR, f"{stem}_annotations.json")


def clips_path(video: str) -> str:
    stem = os.path.splitext(video)[0]
    return os.path.join(OUTPUT_DIR, f"{stem}_clips.json")


def load_or_extract_landmarks(video: str) -> np.ndarray:
    npy = landmarks_npy_path(video)
    if os.path.isfile(npy):
        return np.load(npy)
    lm, _ = pose.extract_landmarks(os.path.join(RAW_DIR, video))
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    np.save(npy, lm)
    return lm


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

    @app.after_request
    def _no_cache(resp):
        # Herramienta de dev: que el browser nunca sirva HTML/JS/CSS viejos de cache.
        if resp.mimetype in ("text/html", "application/javascript", "text/css"):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.get("/api/frame/<video>/<int:n>")
    def api_frame(video: str, n: int):
        path = video_path(video)
        jpeg = reader.get_jpeg(path, n)
        return Response(jpeg, mimetype="image/jpeg")

    @app.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    @app.get("/compare")
    def compare():
        return send_from_directory(STATIC_DIR, "compare.html")

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

    @app.get("/api/landmarks/<video>")
    def api_landmarks(video: str):
        video_path(video)  # valida existencia / 404
        lm = load_or_extract_landmarks(video)
        # NaN -> None para JSON válido (plain Python floats/None, no numpy scalars).
        clean = [[[None if math.isnan(v) else v for v in pt] for pt in frame]
                 for frame in lm.tolist()]
        return jsonify(landmarks=clean, n_frames=len(clean))

    @app.get("/api/annotations/<video>")
    def api_get_annotations(video: str):
        video_path(video)  # 404 si no existe el video
        path = annotations_path(video)
        if os.path.isfile(path):
            with open(path) as f:
                return jsonify(json.load(f))
        return jsonify(video=video, corrections={}, angles=[], drawings={})

    @app.post("/api/annotations/<video>")
    def api_post_annotations(video: str):
        video_path(video)
        data = request.get_json(force=True, silent=True)
        if not isinstance(data, dict):
            abort(400)
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        with open(annotations_path(video), "w") as f:
            json.dump(data, f, indent=2)
        return jsonify(ok=True)

    @app.get("/api/clips/<video>")
    def api_get_clips(video: str):
        video_path(video)  # 404 si no existe el video
        path = clips_path(video)
        if os.path.isfile(path):
            with open(path) as f:
                return jsonify(json.load(f))
        return jsonify(video=video, clips=[])

    @app.post("/api/clips/<video>")
    def api_post_clips(video: str):
        video_path(video)
        data = request.get_json(force=True, silent=True)
        if not isinstance(data, dict):
            abort(400)
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        with open(clips_path(video), "w") as f:
            json.dump(data, f, indent=2)
        return jsonify(ok=True)

    return app


if __name__ == "__main__":
    # Puerto 5001: en macOS el AirPlay Receiver ocupa el 5000 y devuelve 403,
    # enmascarando si nuestro server está caído. threaded=True + lock en FrameReader.
    import os as _os
    port = int(_os.environ.get("PORT", "5001"))
    create_app().run(host="127.0.0.1", port=port, threaded=True)
