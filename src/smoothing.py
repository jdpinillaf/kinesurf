"""Suavizado de trayectorias de landmarks con filtro Savitzky-Golay.

Fase 0. Las coords crudas de MediaPipe tienen jitter frame a frame. Savitzky-Golay
suaviza preservando la forma de los picos (mejor que media móvil para detectar
fases y medir ángulos). Se aplica por canal (x, y, z) sobre el eje temporal.

Los NaN (frames sin pose) se interpolan linealmente ANTES de filtrar; si quedan NaN
en los bordes se rellenan con el valor válido más cercano. La columna de visibility
(índice 3) NO se suaviza: se interpola pero se deja cruda para el cálculo de confianza.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import savgol_filter

# --- Constantes tunables -------------------------------------------------------

# Ventana del filtro (en frames). Debe ser impar y > POLYORDER. A ~30fps un gesto
# de ~1s son ~30 frames; ventana 11 suaviza jitter sin aplastar la dinámica del
# pop-up. Si el video es muy corto se reduce automáticamente (ver _odd_window).
SAVGOL_WINDOW = 11
SAVGOL_POLYORDER = 3


def _interp_nan_1d(series: np.ndarray) -> np.ndarray:
    """Interpola linealmente los NaN de una serie 1D. Bordes: nearest valid."""
    s = series.astype(np.float64).copy()
    nans = np.isnan(s)
    if nans.all():
        return s  # serie totalmente vacía: no hay nada que interpolar
    idx = np.arange(s.size)
    s[nans] = np.interp(idx[nans], idx[~nans], s[~nans])
    return s


def _odd_window(n_frames: int) -> int:
    """Ventana impar válida para Savitzky-Golay dado el nº de frames disponibles."""
    w = min(SAVGOL_WINDOW, n_frames)
    if w % 2 == 0:
        w -= 1
    return max(w, SAVGOL_POLYORDER + 1 + ((SAVGOL_POLYORDER) % 2 == 0))


def smooth_landmarks(landmarks: np.ndarray) -> np.ndarray:
    """Suaviza las trayectorias de landmarks.

    Args:
        landmarks: np.ndarray [n_frames, 33, 4] con (x, y, z, visibility).
                   Frames sin pose vienen como NaN.

    Returns:
        np.ndarray [n_frames, 33, 4]. Canales x/y/z interpolados + Savitzky-Golay;
        visibility solo interpolado (sin filtrar).
    """
    if landmarks.ndim != 3 or landmarks.shape[2] != 4:
        raise ValueError(f"Se esperaba [n_frames, 33, 4], llegó {landmarks.shape}")

    n_frames, n_lm, _ = landmarks.shape
    out = landmarks.astype(np.float64).copy()

    # 1) Interpolar NaN en los 4 canales de cada landmark.
    for j in range(n_lm):
        for c in range(4):
            out[:, j, c] = _interp_nan_1d(out[:, j, c])

    # 2) Savitzky-Golay solo en x, y, z (canales 0..2). Necesita >= window frames.
    if n_frames >= SAVGOL_POLYORDER + 2:
        win = _odd_window(n_frames)
        if win > SAVGOL_POLYORDER:
            for j in range(n_lm):
                for c in range(3):
                    out[:, j, c] = savgol_filter(
                        out[:, j, c], window_length=win, polyorder=SAVGOL_POLYORDER
                    )

    return out.astype(np.float32)
