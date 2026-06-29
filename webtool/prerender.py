"""Pre-renderiza los frames de uno o más videos a JPEG en disco, para que el visor
sirva cada frame leyendo un archivo (~ms) en vez de decodificar HEVC en vivo (~300ms).

Uso:
    ./venv/bin/python -m webtool.prerender profesor_carving.mp4 estudiante_carving.mov
    ./venv/bin/python -m webtool.prerender            # todos los videos de data/raw/

Salida: data/output/frames/<stem>/<n>.jpg  (gitignored). Correr una vez por video.
"""
from __future__ import annotations

import os
import sys
import time

from webtool.frames import prerender

RAW_DIR = "data/raw"
FRAMES_DIR = os.path.join("data", "output", "frames")
VIDEO_EXTS = (".mov", ".mp4", ".avi", ".mkv")


def main(videos: list[str]) -> None:
    if not videos:
        videos = sorted(
            f for f in os.listdir(RAW_DIR) if f.lower().endswith(VIDEO_EXTS)
        )
    for v in videos:
        stem = os.path.splitext(v)[0]
        out = os.path.join(FRAMES_DIR, stem)
        t = time.time()
        n = prerender(os.path.join(RAW_DIR, v), out)
        print(f"{v}: {n} frames -> {out} ({time.time() - t:.0f}s)")
    print("DONE")


if __name__ == "__main__":
    main(sys.argv[1:])
