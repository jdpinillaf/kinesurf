"""Prueba rápida del pipeline hasta fases: pose -> suavizado -> detección de fases.

Uso:
    ./venv/bin/python try_popup.py data/raw/PopUpLateral.mov

Imprime % de confianza, los frames/tiempos de cada fase y el tiempo de pop-up,
y guarda un gráfico de timeline en data/output/<nombre>_timeline.png.
"""

import os
import sys

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from src import pose, smoothing, phases


def main(video_path: str) -> None:
    name = os.path.splitext(os.path.basename(video_path))[0]
    print(f"\n=== {name} ===")

    # 1) Pose
    lm_raw, meta = pose.extract_landmarks(video_path)
    print(f"frames: {meta['n_frames']}  sin pose: {meta['n_frames_sin_pose']}  "
          f"conf>0.7: {meta['pct_high_confidence']:.1f}%  fps: {meta['fps']:.1f}")
    if meta["fps_warning"]:
        print(f"  ⚠ {meta['fps_warning']}")

    # 2) Suavizado
    lm = smoothing.smooth_landmarks(lm_raw)

    # 3) Fases
    r = phases.detect_phases(lm, meta["fps"])
    print(f"\ndetectado: {r.detected}" + (f"  | {r.note}" if r.note else ""))
    for ph in phases.PHASE_ORDER:
        fr, t = r.starts.get(ph), r.start_times.get(ph)
        print(f"  {ph:11s} frame={fr}  t={t}s")
    print(f"\n  POP-UP TIME: {r.popup_time_s} s")

    # 4) Timeline
    colors = {"prono": "#b9b9e0", "push": "#ffcc88",
              "transicion": "#88ccff", "stance": "#88ee88"}
    fig, ax = plt.subplots(figsize=(11, 2.2))
    n = lm.shape[0]
    for f in range(n):
        lbl = r.frame_labels[f]
        if lbl in colors:
            ax.axvspan(f / meta["fps"], (f + 1) / meta["fps"],
                       color=colors[lbl], lw=0)
    for ph in phases.PHASE_ORDER:
        t = r.start_times.get(ph)
        if t is not None:
            ax.axvline(t, color="k", lw=1)
            ax.text(t, 0.5, " " + ph, rotation=90, va="center", fontsize=8)
    ax.set_yticks([])
    ax.set_xlabel("tiempo (s)")
    ax.set_title(f"{name} — fases del pop-up  (pop-up: {r.popup_time_s}s)")
    out = f"data/output/{name}_timeline.png"
    plt.tight_layout()
    plt.savefig(out, dpi=90)
    print(f"\n  timeline -> {out}")


if __name__ == "__main__":
    video = sys.argv[1] if len(sys.argv) > 1 else "data/raw/PopUpLateral.mov"
    main(video)
