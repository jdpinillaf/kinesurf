# Motor Visual Web — Herramienta de Etiquetado (Fase 0, soporte de validación)

**Fecha:** 2026-06-26
**Estado:** Diseño aprobado, pendiente de plan de implementación

## Contexto

El proyecto Surf Pop-Up Analyzer está en Fase 0: un notebook de Python que valida si la
pose estimation produce métricas biomecánicas útiles a partir de videos del pop-up en tierra.
Ya están construidos y validados `src/pose.py` (extracción de 33 landmarks + fix de rotación
iPhone), `src/smoothing.py` (Savitzky-Golay) y `src/phases.py` (máquina de estados de fases).

Esta herramienta es **complementaria, no un reemplazo** del notebook. Su propósito es generar
**ground-truth** y permitir inspección visual frame-a-frame para **tunear los umbrales** de
`phases.py` y `metrics.py` con datos reales.

> **Nota sobre CLAUDE.md:** el spec de Fase 0 prohíbe explícitamente frameworks web, API y
> servidores ("NO usar: frameworks web... Sin auth, sin API, sin DB"). El usuario anuló esta
> restricción de forma explícita para esta herramienta, eligiendo un servidor Flask por la
> comodidad de persistencia. El notebook de validación sigue siendo el entregable de Fase 0;
> esto vive aparte en `webtool/` y no contamina los módulos de `src/`.

## Objetivo

Una app web local que permita:
1. Subir/seleccionar un video del pop-up.
2. Pausarlo y navegarlo **frame por frame** (preciso).
3. Ver el esqueleto de MediaPipe superpuesto.
4. Tres herramientas de anotación:
   - **Corregir landmarks**: arrastrar puntos mal detectados a su posición correcta.
   - **Ángulos manuales**: clickear 3 puntos para medir un ángulo a mano.
   - **Dibujo libre**: trazos tipo telestrator de coach.
5. Guardar las anotaciones a disco como JSON.

## No-objetivos (YAGNI)

- Auth, multi-usuario, base de datos.
- Etiquetado de límites de fase (el usuario no lo pidió).
- Exportar video anotado renderizado.
- Aplicar las correcciones de vuelta a `metrics.py`/`phases.py` → **follow-up**, no v1.

## Stack

- **Backend:** Flask (un archivo). Reusa `src/pose.py` para extracción y orientación-auto.
- **Frontend:** HTML + JavaScript vanilla + `<canvas>`. Sin framework, sin build, sin npm.
- **Persistencia:** archivos JSON en `data/output/<video>_annotations.json`.
- Dependencia nueva: `flask` (opencv, numpy ya están en `requirements.txt`).

## Arquitectura

```
webtool/
├── server.py            # Flask: sirve frames, landmarks, persiste anotaciones
└── static/
    ├── index.html
    ├── app.js           # canvas, herramientas, sync frame<->overlay
    └── style.css
```

### Endpoints

| Método | Ruta | Hace |
|---|---|---|
| GET | `/` | sirve `index.html` |
| GET | `/api/videos` | lista videos en `data/raw/` |
| GET | `/api/meta/<video>` | `{fps, n_frames, width, height, has_landmarks}` |
| GET | `/api/frame/<video>/<n>` | JPEG del frame `n` (cv2 seek + `CAP_PROP_ORIENTATION_AUTO`) |
| GET | `/api/landmarks/<video>` | landmarks `[n,33,4]` como JSON (coords normalizadas 0-1) |
| GET | `/api/annotations/<video>` | anotaciones guardadas (o `{}` si no hay) |
| POST | `/api/annotations/<video>` | persiste el JSON de anotaciones |

### Servido de frames

On-demand: `cv2.VideoCapture` con `CAP_PROP_ORIENTATION_AUTO=1` (mismo fix que `pose.py`, así
los frames coinciden con los landmarks), `cap.set(CAP_PROP_POS_FRAMES, n)`, `read()`, encode a
JPEG. Cache LRU simple en memoria (últimos ~60 frames) para que ◀▶ sea fluido. Sin escribir
frames a disco. Para los videos cortos del proyecto (~200 frames) el seek es rápido.

### Landmarks

Se leen del `.npy` existente (`data/output/<video>_landmarks.npy`) si está; si no, se extraen
con `pose.py` en el primer request y se cachean. Se sirven con coords ya normalizadas 0-1
(como las produce MediaPipe / `pose.py`), independientes de la resolución de display.

## Frontend

- **Selector de video** (dropdown poblado desde `/api/videos`).
- **Canvas doble**: capa base (frame JPEG) + capa overlay (esqueleto + anotaciones).
- **Navegación frame-a-frame**: botones ◀ ▶, slider, input numérico de frame, play/pause.
  El número de frame es la fuente de verdad; cada cambio pide `/api/frame/<v>/<n>`.
- **Toggle esqueleto** on/off.
- **Barra de herramientas** (modo activo, exclusivo):
  1. **Corregir landmark** — hit-test al punto más cercano al click; drag mueve el punto;
     al soltar guarda `corrections[frame][idx] = [x_norm, y_norm]`.
  2. **Ángulo manual** — 3 clicks (A, vértice B, C); dibuja arco + grados calculados con
     `arccos` del producto punto (misma fórmula que `metrics.py`); guarda en `angles[]`.
  3. **Dibujo libre** — pen down/move/up acumula un trazo; guarda en `drawings[frame][]`.
- **Undo** (pila por frame), **Clear frame**, **Guardar** (POST anotaciones).

### Sistema de coordenadas

Landmarks y anotaciones se almacenan **normalizados 0-1**. El canvas mapea
`norm → px` al dibujar y `px → norm` al capturar input, usando el tamaño mostrado del frame.
Esto mantiene las anotaciones válidas aunque cambie la resolución de display o del video.

## Modelo de datos (anotaciones)

```json
{
  "video": "PopUpLateral.mov",
  "corrections": { "151": { "25": [0.41, 0.72], "27": [0.39, 0.95] } },
  "angles": [
    { "frame": 151, "points": [[0.41,0.30],[0.41,0.72],[0.39,0.95]], "value": 129.3, "label": "rodilla" }
  ],
  "drawings": {
    "151": [ { "tool": "pen", "stroke": [[0.5,0.5],[0.52,0.51]], "color": "#ff0000" } ]
  }
}
```

- Claves de frame como string (JSON no admite claves int).
- `corrections`: frame → índice de landmark → `[x_norm, y_norm]`.
- `angles`: lista de mediciones; `points` son A-B-C, `value` en grados.
- `drawings`: frame → lista de trazos.

Formato diseñado para que un follow-up pueda overlayar `corrections` sobre el `.npy` y
re-correr `phases.py`/`metrics.py` sobre landmarks corregidos.

## Manejo de errores

- Video inexistente → 404.
- Frame fuera de rango → clamp a `[0, n_frames-1]` o 404.
- Sin landmarks (`.npy` ausente y extracción falla) → servir `[]`; el frontend muestra
  "sin pose, corregí desde cero" y deshabilita el toggle de esqueleto.
- Video no-60fps o resolución distinta → ya manejado por `pose.py`; el frontend usa el `fps`
  de `/api/meta` para play/pause.

## Testing

- **Backend (unit):** `/api/meta` devuelve campos correctos; `/api/frame` devuelve JPEG válido
  del tamaño esperado; `/api/landmarks` devuelve la forma `[n,33,4]`; round-trip de
  POST→GET de anotaciones preserva los datos.
- **Frontend (smoke):** test con puppeteer — cargar la página, seleccionar video, avanzar un
  frame, activar cada herramienta, guardar, verificar que el POST llega y persiste.
- QA manual del usuario para la sensación de las herramientas de dibujo.

## Decisiones cerradas

- Flask sobre FastAPI: 1 dependencia, arranca con `python server.py`, async no aporta (cv2 es
  bloqueante, 1 usuario). FastAPI brilla en APIs públicas con muchos clientes — no aplica.
- Aplicar correcciones de vuelta a las métricas: follow-up, no v1.
- QA por smoke test de puppeteer + validación manual del usuario.
