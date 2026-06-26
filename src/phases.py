"""Detección de las 4 fases del pop-up mediante una máquina de estados.

Fase 0 — LÓGICA DE DOMINIO. Recorre la serie temporal de landmarks (ya suavizada)
y marca el frame de inicio de cada fase: prono → push → transición → stance.

Señales-guía (derivadas con datos reales de un video lateral; recordar que en imagen
la coord y CRECE hacia abajo):
  - uprightness u: altura de hombros normalizada entre prono (0) y stance (1).
    En prono los hombros están bajos (y alto); en stance están altos (y bajo).
  - knee: ángulo de rodilla. Recto (~170°) en prono; flexionado (~70-110°) en stance.
  - aw: distancia horizontal |tobillo_x - muñeca_x|. Grande en prono (pies atrás),
    colapsa en la transición (pies viajan adelante bajo el cuerpo).

El video puede empezar con la persona de pie y luego acostarse: la máquina localiza
PRIMERO el tramo prono (meseta de u baja más larga) y detecta el pop-up DESPUÉS de él.
Si no hay prono o no hay subida posterior, reporta fases no detectadas SIN crashear.

Todos los umbrales son constantes claras acá arriba: van a necesitar tuning con más
videos reales.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# Índices (del spec / pose.py).
NARIZ = 0
HOMBROS = [11, 12]
CODOS = [13, 14]
MUNECAS = [15, 16]
CADERAS = [23, 24]
RODILLAS = [25, 26]
TOBILLOS = [27, 28]

# --- Umbrales tunables (ajustar con más videos reales) -------------------------

# uprightness: u < U_PRONO ⇒ tumbado; el stance se gatea de forma RELATIVA (ver abajo).
U_PRONO = 0.20          # por debajo de esto se considera prono (meseta baja)
U_PUSH_START = 0.18     # los hombros empiezan a subir de forma sostenida

# Stance: el surf-stance es un SQUAT, no una postura erguida; además, si el video tiene
# un tramo de pie previo (la persona se acuesta y luego hace el pop-up), la normalización
# de uprightness fija u=1.0 en ese tramo de pie y el stance agachado nunca llega a un
# umbral absoluto alto. Por eso el gate es RELATIVO al pico de uprightness alcanzado tras
# el push: u[f] >= U_STANCE_FRAC * pico, con un piso absoluto para descartar medio-cuerpo.
U_STANCE_FRAC = 0.90    # fracción del pico post-push que cuenta como "hombros arriba"
U_STANCE_FLOOR = 0.60   # piso absoluto: por debajo no es un stance creíble

# Rodilla: discrimina push (piernas aún rectas atrás) de transición (rodillas flexionando).
KNEE_RECTA = 150.0      # > esto = pierna recta (prono/push)
KNEE_STANCE_MAX = 130.0 # en stance la rodilla está flexionada por debajo de esto

# Estabilidad para confirmar stance: velocidad de uprightness pequeña sostenida.
STANCE_STABLE_FRAMES = 6
STANCE_VEL_MAX = 0.010  # |Δu/frame| por debajo de esto = estable

# Tramo prono mínimo (frames) para considerarlo válido.
MIN_PRONO_FRAMES = 5

# Separación mínima push->transición. En un pop-up atlético las rodillas tucan a la vez
# que suben los hombros: push y transición caen casi en el mismo frame. Si el gap es menor
# a esto, NO hay transición distinguible (push fluye directo a stance) y se marca None,
# evitando una fase push de ancho cero en el render.
MIN_PUSH_FRAMES = 3

PHASE_ORDER = ["prono", "push", "transicion", "stance"]


@dataclass
class PhaseResult:
    """Resultado de la detección de fases."""
    starts: dict = field(default_factory=dict)        # fase -> frame de inicio (o None)
    start_times: dict = field(default_factory=dict)   # fase -> segundos (o None)
    frame_labels: np.ndarray = None                   # [n_frames] str con la fase de cada frame
    popup_time_s: float = None                        # push_start -> stance_start (segundos)
    detected: bool = False                            # True si se detectó el pop-up completo
    note: str = ""                                    # mensaje si algo no se detectó
    signals: dict = field(default_factory=dict)       # series para graficar/depurar


def _mean_xy(landmarks: np.ndarray, idxs) -> np.ndarray:
    """Media de coords (x,y) de uno o varios landmarks -> [n_frames, 2]."""
    if isinstance(idxs, int):
        return landmarks[:, idxs, :2]
    return np.nanmean(landmarks[:, idxs, :2], axis=1)


def _angle(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> np.ndarray:
    """Ángulo en B del triángulo A-B-C, en grados, por frame (arccos del prod. punto)."""
    v1 = a - b
    v2 = c - b
    denom = np.linalg.norm(v1, axis=1) * np.linalg.norm(v2, axis=1) + 1e-9
    cos = np.sum(v1 * v2, axis=1) / denom
    return np.degrees(np.arccos(np.clip(cos, -1.0, 1.0)))


def _longest_run(mask: np.ndarray) -> tuple[int, int]:
    """Devuelve (inicio, fin_exclusivo) del run True más largo de un bool array."""
    best_len = best_start = best_end = 0
    i = 0
    n = mask.size
    while i < n:
        if mask[i]:
            j = i
            while j < n and mask[j]:
                j += 1
            if j - i > best_len:
                best_len, best_start, best_end = j - i, i, j
            i = j
        else:
            i += 1
    return best_start, best_end


def compute_signals(landmarks: np.ndarray) -> dict:
    """Calcula las series-guía a partir de los landmarks suavizados."""
    sh = _mean_xy(landmarks, HOMBROS)
    hip = _mean_xy(landmarks, CADERAS)
    wr = _mean_xy(landmarks, MUNECAS)
    ank = _mean_xy(landmarks, TOBILLOS)

    sh_y = sh[:, 1]
    hip_y = hip[:, 1]

    # uprightness: 0 en prono (hombros bajos = y alto), 1 en stance (hombros altos = y bajo).
    sh_prono = np.nanpercentile(sh_y, 85)   # meseta baja (en el piso)
    sh_stance = np.nanpercentile(sh_y, 10)  # más arriba (de pie)
    rng = max(sh_prono - sh_stance, 1e-6)
    upright = np.clip((sh_prono - sh_y) / rng, 0.0, 1.0)

    # ángulos de rodilla y codo (media izq/der). cadera-rodilla-tobillo / hombro-codo-muñeca.
    knee = 0.5 * (
        _angle(landmarks[:, 23, :2], landmarks[:, 25, :2], landmarks[:, 27, :2])
        + _angle(landmarks[:, 24, :2], landmarks[:, 26, :2], landmarks[:, 28, :2])
    )
    elbow = 0.5 * (
        _angle(landmarks[:, 11, :2], landmarks[:, 13, :2], landmarks[:, 15, :2])
        + _angle(landmarks[:, 12, :2], landmarks[:, 14, :2], landmarks[:, 16, :2])
    )

    # distancia horizontal pies<->manos (colapsa en la transición).
    aw = np.abs(ank[:, 0] - wr[:, 0])

    return {
        "sh_y": sh_y, "hip_y": hip_y,
        "upright": upright, "knee": knee, "elbow": elbow, "aw": aw,
        "sh_prono": sh_prono, "sh_stance": sh_stance,
    }


def detect_phases(landmarks: np.ndarray, fps: float) -> PhaseResult:
    """Detecta las fases del pop-up sobre landmarks ya suavizados.

    Args:
        landmarks: [n_frames, 33, 4] suavizado (smoothing.smooth_landmarks).
        fps: cuadros por segundo del video (para los timestamps).

    Returns:
        PhaseResult. Si no se detecta el pop-up completo, detected=False y note explica.
    """
    n = landmarks.shape[0]
    res = PhaseResult()
    res.frame_labels = np.array(["?"] * n, dtype=object)

    if n < MIN_PRONO_FRAMES + 3:
        res.note = f"Video demasiado corto ({n} frames) para detectar fases."
        return res

    sig = compute_signals(landmarks)
    res.signals = sig
    u, knee, aw = sig["upright"], sig["knee"], sig["aw"]

    def t(frame: int):
        return None if frame is None else round(frame / fps, 3)

    # 1) Localizar el tramo PRONO: la meseta de uprightness baja más larga.
    prono_run = _longest_run(u < U_PRONO)
    prono_start, prono_end = prono_run
    if prono_end - prono_start < MIN_PRONO_FRAMES:
        res.note = "No se detectó una fase prono estable (¿la persona no arranca acostada?)."
        return res

    # 2) PUSH: primer frame tras el prono donde los hombros suben de forma sostenida.
    push_start = None
    for f in range(prono_end, n):
        if u[f] >= U_PUSH_START:
            push_start = f
            break
    if push_start is None:
        res.note = "Se detectó prono pero no una subida posterior (pop-up no ejecutado)."
        # marcar lo que haya
        res.frame_labels[prono_start:prono_end] = "prono"
        res.starts = {"prono": prono_start, "push": None, "transicion": None, "stance": None}
        res.start_times = {k: t(v) for k, v in res.starts.items()}
        return res

    # 3) TRANSICION: desde push, primer frame donde la rodilla empieza a flexionar
    #    (pies se tucan adelante) -> deja de ser push.
    transicion_start = None
    for f in range(push_start, n):
        if knee[f] < KNEE_RECTA:
            transicion_start = f
            break

    # Colapso push/transición: en pop-ups atléticos las rodillas tucan a la vez que suben
    # los hombros. Si no hay separación mínima, no hay transición distinguible.
    if transicion_start is not None and transicion_start - push_start < MIN_PUSH_FRAMES:
        transicion_start = None

    # 4) STANCE: primer frame con hombros arriba (gate RELATIVO al pico post-push),
    #    rodilla flexionada y uprightness estable durante STANCE_STABLE_FRAMES.
    #    El gate relativo evita que un tramo de pie previo (que infla la normalización)
    #    haga inalcanzable el umbral para un surf-stance agachado.
    peak_post_push = float(np.nanmax(u[push_start:]))
    u_stance_gate = max(U_STANCE_FRAC * peak_post_push, U_STANCE_FLOOR)
    stance_start = None
    search_from = transicion_start if transicion_start is not None else push_start
    for f in range(search_from, n - STANCE_STABLE_FRAMES):
        if u[f] >= u_stance_gate and knee[f] <= KNEE_STANCE_MAX:
            window = u[f:f + STANCE_STABLE_FRAMES]
            if np.max(np.abs(np.diff(window))) <= STANCE_VEL_MAX:
                stance_start = f
                break

    # Coherencia de orden temporal.
    if transicion_start is not None and stance_start is not None and transicion_start >= stance_start:
        transicion_start = None  # no hubo transición distinguible antes del stance

    res.starts = {
        "prono": prono_start,
        "push": push_start,
        "transicion": transicion_start,
        "stance": stance_start,
    }
    res.start_times = {k: t(v) for k, v in res.starts.items()}

    # Etiquetas por frame (para el render).
    bounds = [(prono_start, "prono"), (push_start, "push")]
    if transicion_start is not None:
        bounds.append((transicion_start, "transicion"))
    if stance_start is not None:
        bounds.append((stance_start, "stance"))
    bounds = [b for b in bounds if b[0] is not None]
    for i, (start, name) in enumerate(bounds):
        end = bounds[i + 1][0] if i + 1 < len(bounds) else n
        res.frame_labels[start:end] = name

    # Tiempo de pop-up: inicio de push -> inicio de stance estable.
    if stance_start is not None:
        res.popup_time_s = round((stance_start - push_start) / fps, 3)
        res.detected = True
    else:
        res.note = "No se confirmó una fase stance estable."

    return res
