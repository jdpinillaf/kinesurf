# Surf Pop-Up Analyzer — Fase 0 (Validación)

Notebook de validación: ¿la pose estimation (MediaPipe) da métricas biomecánicas útiles del
**pop-up de surf grabado en tierra**? Experimento para decidir con datos si vale construir el
producto. NO es producto. Ver `CLAUDE.md` para el spec completo.

## Estado actual (entregable 1)
- [x] `src/pose.py` — extracción de 33 landmarks por frame con MediaPipe Tasks API.
- [x] `notebook.ipynb` — verifica extracción dibujando el esqueleto sobre el primer frame.
- [ ] `phases.py`, `metrics.py`, `render.py`, `report.py` — siguen DESPUÉS de validar con video real.

## Setup
```bash
cd surf-popup-analyzer
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```
El modelo `pose_landmarker_heavy.task` se descarga solo en el primer run (`pose.download_model()`).

## Correr
1. Dropea uno o más videos en `data/raw/` (formatos `.mp4` / `.mov`).
2. Abre el notebook:
   ```bash
   jupyter notebook notebook.ipynb
   ```
3. Corre las celdas. La última muestra el primer frame con el esqueleto encima.
   Si el esqueleto sigue al cuerpo → extracción OK.

## Protocolo de grabación (seguir al grabar)
- **Plano LATERAL fijo** (trípode o apoyado). Cuerpo completo en cuadro de principio a fin.
- **1080p mínimo, 60fps.** El gesto dura ~1s; a 30fps se pierden los picos del movimiento.
- Buena luz, fondo despejado.
- La persona empieza **acostada (prono)** y ejecuta un pop-up completo hasta quedar de pie (stance).

El notebook tolera videos que no son 60fps (avisa pero procesa), frames sin pose (los marca NaN,
no crashea) y resoluciones distintas (coords normalizadas).

## Estructura
```
surf-popup-analyzer/
├── requirements.txt
├── notebook.ipynb        # interfaz: corre el pipeline y visualiza
├── data/raw/             # videos de entrada (gitignored)
├── data/output/          # videos anotados + CSVs (gitignored)
├── models/               # pose_landmarker_heavy.task (gitignored, autodescarga)
└── src/
    └── pose.py           # extracción de landmarks (Tasks API, modelo heavy)
```

## Nota técnica
Se usa el **Tasks API** moderno de MediaPipe (`PoseLandmarker`, modelo `heavy` ≈ `model_complexity=2`),
no el legacy `mp.solutions.pose` (deprecado). El suavizado NO se hace en la extracción: las coords
crudas salen tal cual y se filtrarán con Savitzky-Golay (scipy) en `smoothing.py` en la fase siguiente.
