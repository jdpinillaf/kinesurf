"""Réplica offline del viewer 3D (/pose3d) para auditar frame a frame.

Mismo pipeline que el frontend: world npy → smooth (como ?smooth=1) →
fillOcclusions (port de occlusion.js) → joints core con Y invertida.
Genera: PNG por frame (video original | esqueleto 3D), un MP4, y stats
de dónde/qué joints se pierden.
"""
import os
import sys

import numpy as np
import cv2
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.insert(0, "/Users/jesuspinilla/Repositorios/surf-popup-analyzer")
from src.smoothing import smooth_landmarks

ROOT = "/Users/jesuspinilla/Repositorios/surf-popup-analyzer"
OUT = os.path.join(ROOT, "data/output/pose3d_check")
FRAMES_DIR = os.path.join(ROOT, "data/output/frames/profesor_carving")
F0, F1 = 0, 212

EST_VIS = 2.0
CORE = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32]
BONES = [(11, 13), (13, 15), (12, 14), (14, 16),
         (11, 12), (23, 24), (11, 23), (12, 24),
         (23, 25), (25, 27), (24, 26), (26, 28),
         (27, 31), (28, 32)]
LEFT = {11, 13, 15, 23, 25, 27, 31}
NAMES = {11: "hombro_izq", 12: "hombro_der", 13: "codo_izq", 14: "codo_der",
         15: "muñeca_izq", 16: "muñeca_der", 23: "cadera_izq", 24: "cadera_der",
         25: "rodilla_izq", 26: "rodilla_der", 27: "tobillo_izq", 28: "tobillo_der",
         31: "pie_izq", 32: "pie_der"}
MIN_DRAW, DIM_VIS = 0.2, 0.5
COL_L, COL_R, COL_M = "#0e7c86", "#e76f51", "#5b6b77"


def fill_occlusions(lm, min_vis=0.5, max_gap=45):
    """Port fiel de occlusion.js fillOcclusions (sin correcciones)."""
    out = lm.copy()
    F = lm.shape[0]
    for i in range(33):
        ok = (~np.isnan(lm[:, i, 0])) & (lm[:, i, 3] >= min_vis)
        f = 0
        while f < F:
            if ok[f]:
                f += 1
                continue
            a = f
            b = a
            while b < F and not ok[b]:
                b += 1
            left, right = a - 1, b
            if left >= 0 and right < F and (b - a) <= max_gap:
                pl, pr = lm[left, i, :3], lm[right, i, :3]
                for k in range(a, b):
                    t = (k - left) / (right - left)
                    out[k, i, :3] = pl + (pr - pl) * t
                    out[k, i, 3] = EST_VIS
            f = b
    return out


def hold_edges(lm):
    """Port de holdEdges (pose3d.js): sostener valores confiables en los bordes."""
    out = lm.copy()
    F = lm.shape[0]
    for i in range(33):
        ok = (~np.isnan(lm[:, i, 0])) & ((lm[:, i, 3] >= 0.5) | (lm[:, i, 3] == EST_VIS))
        idx = np.where(ok)[0]
        if not len(idx):
            continue
        first, last = idx[0], idx[-1]
        if first > 0:
            out[:first, i, :3] = lm[first, i, :3]
            out[:first, i, 3] = EST_VIS
        if last < F - 1:
            out[last + 1:, i, :3] = lm[last, i, :3]
            out[last + 1:, i, 3] = EST_VIS
    return out


def pt(world, f, i):
    p = world[f, i]
    if np.isnan(p[0]):
        return None
    vis = p[3]
    est = vis == EST_VIS
    if not est and vis < MIN_DRAW:
        return None
    # escena: X=x, Y_up=-y, Z=-z  → para matplotlib 3D usamos (x, -z, -y)
    return dict(x=p[0], y=-p[2], z=-p[1], dim=(est or vis < DIM_VIS))


def render_frame(world, f, ax):
    ax.cla()
    ax.set_xlim(-0.9, 0.9); ax.set_ylim(-0.9, 0.9); ax.set_zlim(-1.0, 0.8)
    ax.set_axis_off()
    ax.view_init(elev=12, azim=-60)
    for (a, b) in BONES:
        pa, pb = pt(world, f, a), pt(world, f, b)
        if not pa or not pb:
            continue
        side = COL_L if (a in LEFT and b in LEFT) else \
            (COL_R if (a not in LEFT and b not in LEFT and a >= 11) else COL_M)
        if {a, b} in ({11, 12}, {23, 24}, {11, 23}, {12, 24}):
            side = COL_M
        alpha = 0.35 if (pa["dim"] or pb["dim"]) else 1.0
        ax.plot([pa["x"], pb["x"]], [pa["y"], pb["y"]], [pa["z"], pb["z"]],
                color=side, lw=4, alpha=alpha, solid_capstyle="round")
    for i in CORE:
        p = pt(world, f, i)
        if not p:
            continue
        c = COL_L if i in LEFT else COL_R
        ax.scatter([p["x"]], [p["y"]], [p["z"]], color=c, s=36,
                   alpha=0.35 if p["dim"] else 1.0)
    # cabeza: medio de orejas (7,8) o nariz (0)
    e1, e2, nose = pt(world, f, 7), pt(world, f, 8), pt(world, f, 0)
    if e1 and e2:
        hx, hy, hz = (e1["x"] + e2["x"]) / 2, (e1["y"] + e2["y"]) / 2, (e1["z"] + e2["z"]) / 2
        hdim = e1["dim"] or e2["dim"]
    elif nose:
        hx, hy, hz, hdim = nose["x"], nose["y"], nose["z"], nose["dim"]
    else:
        hx = None
    s1, s2 = pt(world, f, 11), pt(world, f, 12)
    if hx is not None:
        ax.scatter([hx], [hy], [hz], color=COL_M, s=380, alpha=0.35 if hdim else 1.0)
        if s1 and s2:
            ax.plot([(s1["x"] + s2["x"]) / 2, hx], [(s1["y"] + s2["y"]) / 2, hy],
                    [(s1["z"] + s2["z"]) / 2, hz], color=COL_M, lw=4,
                    alpha=0.35 if (hdim or s1["dim"] or s2["dim"]) else 1.0)


def main():
    os.makedirs(OUT, exist_ok=True)
    raw = np.load(os.path.join(ROOT, "data/output/profesor_carving_worldlandmarks.npy"))
    smoothed = smooth_landmarks(raw)
    world = hold_edges(fill_occlusions(smoothed, max_gap=120))

    # ── stats por frame: qué joints core faltan o van translúcidos ──────────────
    report = []
    for f in range(F0, min(F1 + 1, world.shape[0])):
        missing, dim = [], []
        for i in CORE:
            p = pt(world, f, i)
            if p is None:
                missing.append(NAMES[i])
            elif p["dim"]:
                dim.append(NAMES[i])
        report.append((f, missing, dim))

    lost_frames = [(f, m) for f, m, _ in report if m]
    print(f"frames analizados: {F0}-{min(F1, world.shape[0]-1)}")
    print(f"frames con joints PERDIDOS (ni relleno): {len(lost_frames)}")
    from collections import Counter
    cm = Counter(j for _, m in lost_frames for j in m)
    print("joints más perdidos:", cm.most_common(8))
    cd = Counter(j for _, _, d in report for j in d)
    print("joints más translúcidos (estimados/baja conf):", cd.most_common(8))
    # rangos contiguos de pérdida
    print("\nrangos con pérdida:")
    prev_set, start = None, None
    for f, m, _ in report + [(10**9, [], [])]:
        s = tuple(sorted(m))
        if s != prev_set:
            if prev_set:
                print(f"  f{start}-f{f-1}: {', '.join(prev_set)}")
            prev_set, start = s if s else None, f
    # ── render PNG por frame + MP4 ───────────────────────────────────────────────
    fig = plt.figure(figsize=(4.2, 5.6), dpi=80)
    ax = fig.add_subplot(111, projection="3d")
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    vw = None
    for f, missing, dimj in report:
        render_frame(world, f, ax)
        fig.canvas.draw()
        sk = np.asarray(fig.canvas.buffer_rgba())[:, :, :3][:, :, ::-1].copy()
        vid = cv2.imread(os.path.join(FRAMES_DIR, f"{f}.jpg"))
        if vid is None:
            vid = np.zeros((sk.shape[0], sk.shape[0] * 9 // 16, 3), np.uint8)
        vh = sk.shape[0]
        vid = cv2.resize(vid, (int(vid.shape[1] * vh / vid.shape[0]), vh))
        combo = np.hstack([vid, sk])
        label = f"f {f}"
        if missing:
            label += "  PERDIDOS: " + ",".join(missing)
        cv2.putText(combo, label, (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                    (30, 42, 51), 2, cv2.LINE_AA)
        cv2.imwrite(os.path.join(OUT, f"f_{f:04d}.png"), combo)
        if vw is None:
            vw = cv2.VideoWriter(os.path.join(OUT, "check_0_212.mp4"),
                                 cv2.VideoWriter_fourcc(*"mp4v"), 15,
                                 (combo.shape[1], combo.shape[0]))
        vw.write(combo)
    vw.release()
    print(f"\nPNGs + MP4 en {OUT}")


if __name__ == "__main__":
    main()
