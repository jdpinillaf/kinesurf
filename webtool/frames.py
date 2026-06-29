"""Lectura de frames de video on-demand con cache LRU, para el motor visual.

Mantiene un VideoCapture abierto por video (con orientación-auto, igual que pose.py)
y cachea los últimos frames codificados a JPEG para que la navegación ◀▶ sea fluida.
"""
from __future__ import annotations

import logging
import os
import threading
from collections import OrderedDict

import cv2

CACHE_SIZE = 64
JPEG_QUALITY = 85


def prerender(video_path: str, out_dir: str, max_height: int = 720,
              quality: int = 80) -> int:
    """Decodifica el video SECUENCIALMENTE (sin seeks) y guarda cada frame como
    JPEG downscaleado en out_dir/<n>.jpg. Servir luego un frame = leer un archivito
    (~ms) en vez de seek+decode HEVC+encode en vivo (~300ms en 1080x1920).

    Devuelve la cantidad de frames escritos. Idempotente: re-escribe.
    """
    os.makedirs(out_dir, exist_ok=True)
    cap = cv2.VideoCapture(video_path)
    cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
    n = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            h, w = frame.shape[:2]
            if h > max_height:
                scale = max_height / h
                frame = cv2.resize(frame, (round(w * scale), max_height),
                                   interpolation=cv2.INTER_AREA)
            cv2.imwrite(os.path.join(out_dir, f"{n}.jpg"), frame,
                        [int(cv2.IMWRITE_JPEG_QUALITY), quality])
            n += 1
    finally:
        cap.release()
    return n


class FrameReader:
    def __init__(self) -> None:
        self._caps: dict[str, cv2.VideoCapture] = {}
        self._counts: dict[str, int] = {}
        self._cache: "OrderedDict[tuple[str, int], bytes]" = OrderedDict()
        # OpenCV VideoCapture no es thread-safe: un solo cap por video compartido
        # entre requests concurrentes (dev server multi-thread, 2 panes reproduciendo)
        # corrompe el decode de ffmpeg. Serializamos seek+read+cache con un lock.
        self._lock = threading.Lock()

    def _cap(self, path: str) -> cv2.VideoCapture:
        cap = self._caps.get(path)
        if cap is None:
            cap = cv2.VideoCapture(path)
            cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
            self._caps[path] = cap
            self._counts[path] = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        return cap

    def get_jpeg(self, path: str, n: int) -> bytes:
        with self._lock:
            return self._get_jpeg_locked(path, n)

    def _get_jpeg_locked(self, path: str, n: int) -> bytes:
        cap = self._cap(path)
        total = self._counts[path]
        n = max(0, min(n, total - 1))
        requested = n  # Fix 1: capture original clamped index before retry
        key = (path, n)
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        cap.set(cv2.CAP_PROP_POS_FRAMES, n)
        ok, frame = cap.read()
        # CAP_PROP_FRAME_COUNT puede sobreestimar (común en .MOV de iPhone).
        # Si el read falla, retrocedemos hasta encontrar el último frame legible.
        while not ok and n > 0:
            n -= 1
            key = (path, n)  # actualizar clave al n real
            cap.set(cv2.CAP_PROP_POS_FRAMES, n)
            ok, frame = cap.read()
        if not ok:
            raise IndexError(f"No se pudo leer ningún frame de {path}")
        # Fix 1: emit one warning per retried request
        if n != requested:
            logging.warning(
                "Frame %d unreadable in %s, served %d instead", requested, path, n
            )
        ok, buf = cv2.imencode(
            ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY]
        )
        data = buf.tobytes()
        # Fix 3: removed redundant move_to_end — fresh assignment already appends to end
        self._cache[key] = data
        # Fix 2: also cache the originally-requested key to avoid re-triggering retry
        if n != requested:
            self._cache[(path, requested)] = data
        while len(self._cache) > CACHE_SIZE:
            self._cache.popitem(last=False)
        return data
