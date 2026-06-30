"""Extracción de pose con MediaPipe Tasks API (PoseLandmarker).

Fase 0 — entregable 1. Dado un video, devuelve la serie temporal de 33 landmarks
[frames, 33, 4] (x, y, z, visibility) y metadata incluyendo el % de frames con
buena confianza.

Decisión de stack: Tasks API moderno (PoseLandmarker), NO el legacy mp.solutions.pose
(deprecado). Modelo 'heavy' = equivalente a model_complexity=2. El suavizado NO se hace
aquí: las coords crudas salen tal cual y se filtran después con Savitzky-Golay en
smoothing.py (fase posterior).
"""

from __future__ import annotations

import os
import ssl
import urllib.request
import warnings

import certifi
import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

# --- Constantes tunables (ajustar con videos reales) ---------------------------

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(_THIS_DIR, "..", "models")
MODEL_PATH = os.path.join(MODELS_DIR, "pose_landmarker_heavy.task")
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task"
)

# Confianzas de MediaPipe (detección/tracking). Bajas a propósito: queremos que
# detecte aun en frames difíciles (prono) y luego filtramos por visibility.
MIN_POSE_DETECTION_CONFIDENCE = 0.5
MIN_TRACKING_CONFIDENCE = 0.5

# Umbral del criterio de éxito del spec: landmark "confiable" si visibility > 0.7.
CONFIDENCE_THRESHOLD = 0.7

FPS_ESPERADO = 60  # el gesto dura ~1s; <60fps pierde picos (solo warning, igual procesa)

N_LANDMARKS = 33  # MediaPipe Pose

# Índices de landmarks relevantes (del spec).
LANDMARK_NAMES = {
    0: "nariz",
    11: "hombro_izq", 12: "hombro_der",
    13: "codo_izq", 14: "codo_der",
    15: "muneca_izq", 16: "muneca_der",
    23: "cadera_izq", 24: "cadera_der",
    25: "rodilla_izq", 26: "rodilla_der",
    27: "tobillo_izq", 28: "tobillo_der",
}

# Conexiones del esqueleto para dibujar (subconjunto estándar de MediaPipe Pose).
POSE_CONNECTIONS = [
    (11, 12), (11, 13), (13, 15), (12, 14), (14, 16),       # brazos + hombros
    (11, 23), (12, 24), (23, 24),                            # torso
    (23, 25), (25, 27), (24, 26), (26, 28),                  # piernas
    (0, 11), (0, 12),                                        # cabeza→hombros
]


# --- Modelo --------------------------------------------------------------------

def download_model(force: bool = False) -> str:
    """Descarga pose_landmarker_heavy.task a models/ si falta. Devuelve la ruta."""
    os.makedirs(MODELS_DIR, exist_ok=True)
    if force or not os.path.exists(MODEL_PATH):
        print(f"Descargando modelo heavy → {MODEL_PATH} ...")
        # macOS python.org Python no trae CA certs del sistema; usar el bundle de certifi.
        ctx = ssl.create_default_context(cafile=certifi.where())
        with urllib.request.urlopen(MODEL_URL, context=ctx) as resp, open(MODEL_PATH, "wb") as f:
            f.write(resp.read())
        print("Modelo descargado.")
    return MODEL_PATH


def _build_detector() -> vision.PoseLandmarker:
    """Crea el PoseLandmarker en running_mode=VIDEO."""
    base_options = mp_python.BaseOptions(model_asset_path=MODEL_PATH)
    options = vision.PoseLandmarkerOptions(
        base_options=base_options,
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=MIN_POSE_DETECTION_CONFIDENCE,
        min_tracking_confidence=MIN_TRACKING_CONFIDENCE,
    )
    return vision.PoseLandmarker.create_from_options(options)


# --- Extracción ----------------------------------------------------------------

def extract_landmarks(video_path: str) -> tuple[np.ndarray, dict]:
    """Wrapper retro-compatible: devuelve solo (landmarks 2D imagen, meta).

    Lo usan server.py y notebook.ipynb; mantener esta firma. Para los world landmarks
    3D usar extract_pose().
    """
    landmarks, _world, meta = extract_pose(video_path)
    return landmarks, meta


def extract_pose(video_path: str) -> tuple[np.ndarray, np.ndarray, dict]:
    """Extrae landmarks 2D (imagen) y world 3D (métricos) frame por frame.

    Returns:
        landmarks: np.ndarray [n_frames, 33, 4] con (x, y, z, visibility).
                   Coords x/y normalizadas [0,1] (espacio imagen). Frames sin pose → NaN.
        world:     np.ndarray [n_frames, 33, 4] con (x, y, z, visibility).
                   x/y/z en METROS, origen en el centro de las caderas (pose_world_landmarks).
                   No alineado a gravedad. Para ángulos articulares 3D. Frames sin pose → NaN.
        meta: dict con fps, n_frames, width, height, fps_warning, n_frames_sin_pose,
              pct_high_confidence.
    """
    if not os.path.exists(MODEL_PATH):
        download_model()

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise FileNotFoundError(f"No se pudo abrir el video: {video_path}")

    # iPhone/Android guardan rotación en metadata (display matrix) que OpenCV ignora
    # por defecto -> frames salen rotados 90/180 y rompen la lógica de alturas (y) y
    # ángulos respecto a la horizontal. Auto-aplicar la orientación del contenedor.
    cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
    rotation_meta = cap.get(cv2.CAP_PROP_ORIENTATION_META)

    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    # width/height tras auto-orientación se toman del frame real (ver loop), no del
    # contenedor (que reporta las dims sin rotar).
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    fps_warning = None
    if fps <= 0:
        fps_warning = "FPS no reportado por el contenedor; asumo 60 para timestamps."
        warnings.warn(fps_warning)
        fps = float(FPS_ESPERADO)
    elif abs(fps - FPS_ESPERADO) > 1:
        fps_warning = (
            f"Video a {fps:.1f}fps (esperado {FPS_ESPERADO}fps). Se procesa igual, "
            "pero el pop-up (~1s) puede perder picos por submuestreo temporal."
        )
        warnings.warn(fps_warning)

    detector = _build_detector()

    frames_lm: list[np.ndarray] = []
    frames_world: list[np.ndarray] = []
    n_sin_pose = 0
    frame_idx = 0

    try:
        while True:
            ok, frame_bgr = cap.read()
            if not ok:
                break

            # dims reales del frame (ya auto-orientado); sobrescriben las del contenedor
            height, width = frame_bgr.shape[:2]
            frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame_rgb)
            timestamp_ms = int(frame_idx / fps * 1000)

            result = detector.detect_for_video(mp_image, timestamp_ms)

            if result.pose_landmarks:
                lms = result.pose_landmarks[0]
                arr = np.array(
                    [[lm.x, lm.y, lm.z, lm.visibility] for lm in lms],
                    dtype=np.float32,
                )
            else:
                arr = np.full((N_LANDMARKS, 4), np.nan, dtype=np.float32)
                n_sin_pose += 1

            # world landmarks 3D (métricos, centrados en cadera). Pueden faltar aunque
            # haya pose 2D → NaN en ese caso.
            if result.pose_world_landmarks:
                wlms = result.pose_world_landmarks[0]
                warr = np.array(
                    [[lm.x, lm.y, lm.z, lm.visibility] for lm in wlms],
                    dtype=np.float32,
                )
            else:
                warr = np.full((N_LANDMARKS, 4), np.nan, dtype=np.float32)

            frames_lm.append(arr)
            frames_world.append(warr)
            frame_idx += 1
    finally:
        cap.release()
        detector.close()

    landmarks = (
        np.stack(frames_lm, axis=0)
        if frames_lm
        else np.empty((0, N_LANDMARKS, 4), dtype=np.float32)
    )
    world = (
        np.stack(frames_world, axis=0)
        if frames_world
        else np.empty((0, N_LANDMARKS, 4), dtype=np.float32)
    )

    meta = {
        "fps": fps,
        "n_frames": landmarks.shape[0],
        "total_frames_reportados": total_frames,
        "width": width,
        "height": height,
        "rotation_meta": rotation_meta,
        "fps_warning": fps_warning,
        "n_frames_sin_pose": n_sin_pose,
        "pct_high_confidence": pct_high_confidence(landmarks),
    }
    return landmarks, world, meta


def pct_high_confidence(landmarks: np.ndarray) -> float:
    """% de frames donde la visibility MEDIA de los landmarks supera CONFIDENCE_THRESHOLD.

    Proxy del criterio de éxito del spec (confianza > 0.7). Afinable: el spec apunta
    sobre todo a las fases de transición/stance, pero aquí lo medimos sobre todo el
    video (sin fases detectadas todavía). Frames sin pose (NaN) cuentan como baja.
    """
    if landmarks.shape[0] == 0:
        return 0.0
    vis = landmarks[:, :, 3]                       # [frames, 33]
    with warnings.catch_warnings():                # frames all-NaN (sin pose) → media vacía, esperado
        warnings.simplefilter("ignore", category=RuntimeWarning)
        mean_vis = np.nanmean(vis, axis=1)         # media por frame, ignora NaN
    mean_vis = np.nan_to_num(mean_vis, nan=0.0)    # frame sin pose → 0
    return float(np.mean(mean_vis > CONFIDENCE_THRESHOLD) * 100.0)


# --- Dibujo (helper; render.py completo viene después) -------------------------

def draw_skeleton(frame_bgr: np.ndarray, landmarks_frame: np.ndarray) -> np.ndarray:
    """Dibuja los 33 puntos + conexiones de UN frame sobre la imagen (in-place copy).

    landmarks_frame: np.ndarray [33, 4] con coords normalizadas. NaN → se omite.
    """
    img = frame_bgr.copy()
    h, w = img.shape[:2]

    def px(i):
        x, y = landmarks_frame[i, 0], landmarks_frame[i, 1]
        if np.isnan(x) or np.isnan(y):
            return None
        return int(x * w), int(y * h)

    # conexiones
    for a, b in POSE_CONNECTIONS:
        pa, pb = px(a), px(b)
        if pa and pb:
            cv2.line(img, pa, pb, (0, 255, 0), 2)

    # puntos
    for i in range(min(N_LANDMARKS, landmarks_frame.shape[0])):
        p = px(i)
        if p:
            cv2.circle(img, p, 4, (0, 0, 255), -1)

    return img
