"""Servidor Flask del motor visual de etiquetado (Fase 0, soporte de validación).

Sirve frames de video, landmarks de MediaPipe y persiste anotaciones a JSON.
Arranca con: ./venv/bin/python -m webtool.server
"""
from __future__ import annotations

import json
import math
import os
import threading

import cv2
import numpy as np
from flask import (Flask, Response, abort, jsonify, request, send_file,
                   send_from_directory)
from webtool.frames import FrameReader
from src import pose
from src.smoothing import smooth_landmarks

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


def worldlandmarks_npy_path(video: str) -> str:
    stem = os.path.splitext(video)[0]
    return os.path.join(OUTPUT_DIR, f"{stem}_worldlandmarks.npy")


def annotations_path(video: str) -> str:
    stem = os.path.splitext(video)[0]
    return os.path.join(OUTPUT_DIR, f"{stem}_annotations.json")


def clips_path(video: str) -> str:
    stem = os.path.splitext(video)[0]
    return os.path.join(OUTPUT_DIR, f"{stem}_clips.json")


def prerendered_frame_path(video: str, n: int) -> str:
    stem = os.path.splitext(video)[0]
    return os.path.join(OUTPUT_DIR, "frames", stem, f"{n}.jpg")


def sequence_path(video: str) -> str:
    stem = os.path.splitext(video)[0]
    return os.path.join(OUTPUT_DIR, f"{stem}_sequence.json")


# Librería de videos: tags {maniobra, persona, rol} por video + taxonomía editable.
LIBRARY_PATH = os.path.join(OUTPUT_DIR, "library.json")
DEFAULT_MANIOBRAS = [
    "pop-up", "carving", "bottom-turn", "cutback", "snap", "backside",
    "rotación hombros", "rotación un pie", "flutter", "otro",
]


# --- Extracción de pose en background ---------------------------------------
# La extracción de MediaPipe es heavy (5-16 min por video). NUNCA correrla dentro
# de un request handler: bloquea el server entero (threaded pero el GIL + el trabajo
# CPU-bound cuelga a todos). En su lugar: un thread daemon la corre, el endpoint
# responde 202 "processing" y el frontend pollea hasta que el .npy aparece.
_jobs: dict[str, str] = {}          # video -> "processing" | "done" | "error:<msg>"
_jobs_lock = threading.Lock()       # protege _jobs
_extract_lock = threading.Lock()    # serializa la extracción (1 a la vez, sin thrash)


def _extract_worker(video: str) -> None:
    """Corre en un thread daemon: extrae 2d+world en UNA pasada y guarda ambos npy."""
    try:
        with _extract_lock:  # una extracción a la vez
            # Re-check: otro job pudo haberlo generado mientras esperábamos el lock.
            if os.path.isfile(landmarks_npy_path(video)) and \
                    os.path.isfile(worldlandmarks_npy_path(video)):
                with _jobs_lock:
                    _jobs[video] = "done"
                return
            lm, world, _ = pose.extract_pose(os.path.join(RAW_DIR, video))
            os.makedirs(OUTPUT_DIR, exist_ok=True)
            np.save(landmarks_npy_path(video), lm)
            np.save(worldlandmarks_npy_path(video), world)
        with _jobs_lock:
            _jobs[video] = "done"
    except Exception as e:  # noqa: BLE001 — reportar cualquier fallo al frontend
        with _jobs_lock:
            _jobs[video] = f"error:{e}"


def start_extraction(video: str) -> str:
    """Asegura que la extracción de `video` esté en curso o hecha (sin bloquear).

    Devuelve: "ready" si el npy ya existe, "processing" si hay job en curso, o
    "error:<msg>" si el último job falló. Idempotente: no duplica jobs.
    """
    if os.path.isfile(landmarks_npy_path(video)) and \
            os.path.isfile(worldlandmarks_npy_path(video)):
        return "ready"
    with _jobs_lock:
        st = _jobs.get(video, "")
        if st == "processing":
            return "processing"
        if st.startswith("error:"):
            return st  # el frontend decide; se puede reintentar borrando el estado
        _jobs[video] = "processing"
    threading.Thread(target=_extract_worker, args=(video,), daemon=True).start()
    return "processing"


def clean_landmarks(lm: np.ndarray) -> list:
    """np.ndarray [frames,33,4] → listas de Python con NaN convertido a None (JSON válido)."""
    return [[[None if math.isnan(v) else v for v in pt] for pt in frame]
            for frame in lm.tolist()]


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
    from webtool.students import bp as students_bp  # import tardío: evita ciclo
    app.register_blueprint(students_bp)

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
        # rápido: servir el frame pre-renderizado a disco si existe.
        # send_file necesita path ABSOLUTO: con uno relativo Flask lo resuelve
        # contra webtool/ (root_path), no contra el CWD → FileNotFoundError/500.
        pr = prerendered_frame_path(video, n)
        if os.path.isfile(pr):
            return send_file(os.path.abspath(pr), mimetype="image/jpeg")
        # fallback: decodificar on-demand (videos sin pre-render)
        jpeg = reader.get_jpeg(path, n)
        return Response(jpeg, mimetype="image/jpeg")

    @app.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    @app.get("/compare")
    def compare():
        return send_from_directory(STATIC_DIR, "compare.html")

    @app.get("/sequence")
    def sequence():
        return send_from_directory(STATIC_DIR, "sequence.html")

    @app.get("/pose3d")
    def pose3d():
        return send_from_directory(STATIC_DIR, "pose3d.html")

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
        has_lm = os.path.isfile(landmarks_npy_path(video))
        meta["has_landmarks"] = has_lm
        # meta se pide primero en los 3 flujos: arrancar ya la extracción si falta,
        # así el primer poll de /api/landmarks suele encontrarla en curso.
        if not has_lm:
            start_extraction(video)
        return jsonify(meta)

    @app.get("/api/landmarks/<video>")
    def api_landmarks(video: str):
        video_path(video)  # valida existencia / 404
        npy = landmarks_npy_path(video)
        if os.path.isfile(npy):
            clean = clean_landmarks(np.load(npy))  # NaN -> None para JSON válido
            return jsonify(landmarks=clean, n_frames=len(clean))
        # Falta el npy: extraer en background y responder 202 (el frontend pollea).
        st = start_extraction(video)
        if st.startswith("error:"):
            return jsonify(status="error", error=st[len("error:"):]), 500
        return jsonify(status="processing"), 202

    @app.get("/api/worldlandmarks/<video>")
    def api_worldlandmarks(video: str):
        # Landmarks world 3D (métricos, metros, origen en cadera) para ángulos articulares 3D.
        video_path(video)  # valida existencia / 404
        wnpy = worldlandmarks_npy_path(video)
        if os.path.isfile(wnpy):
            arr = np.load(wnpy)
            # ?smooth=1: Savitzky-Golay al servir (anti-wobble del eje z monocular,
            # lo usa el viewer 3D). El npy crudo queda intacto.
            if request.args.get("smooth") == "1":
                arr = smooth_landmarks(arr)
            clean = clean_landmarks(arr)
            return jsonify(landmarks=clean, n_frames=len(clean))
        st = start_extraction(video)
        if st.startswith("error:"):
            return jsonify(status="error", error=st[len("error:"):]), 500
        return jsonify(status="processing"), 202

    @app.get("/api/library")
    def api_get_library():
        if os.path.isfile(LIBRARY_PATH):
            with open(LIBRARY_PATH) as f:
                return jsonify(json.load(f))
        return jsonify(videos={}, maniobras=DEFAULT_MANIOBRAS)

    @app.post("/api/library")
    def api_post_library():
        data = request.get_json(force=True, silent=True)
        if not isinstance(data, dict) or not isinstance(data.get("videos"), dict):
            abort(400)
        data.setdefault("maniobras", DEFAULT_MANIOBRAS)
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        with open(LIBRARY_PATH, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        return jsonify(ok=True)

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

    @app.get("/api/sequence/<video>")
    def api_get_sequence(video: str):
        video_path(video)  # 404 si no existe el video
        path = sequence_path(video)
        if os.path.isfile(path):
            with open(path) as f:
                return jsonify(json.load(f))
        return jsonify(video=video, steps=[])

    @app.post("/api/sequence/<video>")
    def api_post_sequence(video: str):
        video_path(video)
        data = request.get_json(force=True, silent=True)
        if not isinstance(data, dict):
            abort(400)
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        with open(sequence_path(video), "w") as f:
            json.dump(data, f, indent=2)
        return jsonify(ok=True)

    return app


if __name__ == "__main__":
    # Puerto 5001: en macOS el AirPlay Receiver ocupa el 5000 y devuelve 403,
    # enmascarando si nuestro server está caído. threaded=True + lock en FrameReader.
    import os as _os
    port = int(_os.environ.get("PORT", "5001"))
    create_app().run(host="127.0.0.1", port=port, threaded=True)
