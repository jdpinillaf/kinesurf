"""Pre-extrae landmarks 2D + world 3D de uno o más videos a .npy en disco, para que el
endpoint /api/worldlandmarks sirva sin bloquear (la extracción heavy tarda minutos).

Uso:
    ./venv/bin/python -m webtool.extract_world profesor_carving.mp4 estudiante_carving.mov
    ./venv/bin/python -m webtool.extract_world            # todos los videos de data/raw/

Salida: data/output/<stem>_landmarks.npy y <stem>_worldlandmarks.npy (gitignored).
Correr una vez por video (o re-correr para regenerar con world 3D los ya existentes).
"""
from __future__ import annotations

import os
import sys
import time

import numpy as np

from src import pose

RAW_DIR = "data/raw"
OUTPUT_DIR = "data/output"
VIDEO_EXTS = (".mov", ".mp4", ".avi", ".mkv")


def main(videos: list[str]) -> None:
    if not videos:
        videos = sorted(
            f for f in os.listdir(RAW_DIR) if f.lower().endswith(VIDEO_EXTS)
        )
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    for v in videos:
        stem = os.path.splitext(v)[0]
        t = time.time()
        lm, world, meta = pose.extract_pose(os.path.join(RAW_DIR, v))
        np.save(os.path.join(OUTPUT_DIR, f"{stem}_landmarks.npy"), lm)
        np.save(os.path.join(OUTPUT_DIR, f"{stem}_worldlandmarks.npy"), world)
        print(f"{v}: {lm.shape[0]} frames, conf {meta['pct_high_confidence']:.0f}% "
              f"({time.time() - t:.0f}s) -> 2d+world npy")
    print("DONE")


if __name__ == "__main__":
    main(sys.argv[1:])
