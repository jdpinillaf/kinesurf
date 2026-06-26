# Motor Visual Web (Etiquetado) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir una app web local (Flask + canvas vanilla) para navegar un video del pop-up frame por frame, ver el esqueleto de MediaPipe, y anotar (corregir landmarks, medir ángulos a mano, dibujo libre), guardando todo a JSON.

**Architecture:** Backend Flask de un archivo que sirve frames JPEG on-demand (cv2 seek con orientación-auto), landmarks desde los `.npy` existentes, y persiste anotaciones a `data/output/<video>_annotations.json`. Frontend HTML+JS vanilla con doble canvas (frame base + overlay de anotaciones), coords normalizadas 0-1.

**Tech Stack:** Python 3.11, Flask, OpenCV (ya presente), NumPy (ya presente), pytest; frontend HTML/CSS/JavaScript vanilla, `<canvas>`. Reusa `src/pose.py`.

## Global Constraints

- Python 3.11+; usar el intérprete del venv: `./venv/bin/python`, `./venv/bin/pytest`.
- Frontend SIN frameworks, SIN build, SIN npm: HTML + JS vanilla + canvas únicamente.
- Coords de landmarks y anotaciones SIEMPRE normalizadas `[0,1]` (como las produce `pose.py`).
- Servir frames con `cv2.CAP_PROP_ORIENTATION_AUTO = 1` para que coincidan con los landmarks.
- El código del tool vive en `webtool/`; NO modificar módulos de `src/` salvo import.
- Anotaciones se guardan en `data/output/<video>_annotations.json`.
- Reusar `src.pose.extract_landmarks(path) -> (landmarks[n,33,4] float32 norm, meta dict)`.
  `meta` tiene: `fps`, `n_frames`, `width`, `height`, `fps_warning`, `n_frames_sin_pose`,
  `pct_high_confidence`.
- Landmarks cacheados en `data/output/<stem>_landmarks.npy` cuando existen.

---

### Task 1: Dependencias, scaffold y `GET /api/videos`

**Files:**
- Modify: `requirements.txt`
- Create: `webtool/__init__.py`
- Create: `webtool/server.py`
- Create: `tests/__init__.py`
- Create: `tests/test_server.py`
- Create: `conftest.py`

**Interfaces:**
- Produces: módulo Flask `webtool.server` con factory `create_app() -> Flask` y constante
  `RAW_DIR = "data/raw"`, `OUTPUT_DIR = "data/output"`. Ruta `GET /api/videos -> {"videos": [str]}`
  (nombres de archivo de video en `data/raw/`, extensiones `.mov/.mp4/.avi/.mkv`, case-insensitive).

- [ ] **Step 1: Agregar deps a `requirements.txt`**

Añadir al final de `requirements.txt`:

```
flask>=3.0
pytest>=8.0
```

Instalar: `./venv/bin/pip install flask pytest`
Expected: instala sin error.

- [ ] **Step 2: Crear `conftest.py` en la raíz**

```python
"""Configuración de pytest: asegura que la raíz del repo esté en sys.path."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
```

- [ ] **Step 3: Escribir el test que falla**

Create `tests/__init__.py` (vacío). Create `tests/test_server.py`:

```python
import os
import pytest

from webtool.server import create_app


@pytest.fixture
def client():
    app = create_app()
    app.config["TESTING"] = True
    return app.test_client()


def test_list_videos_returns_existing_raw_videos(client):
    resp = client.get("/api/videos")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "videos" in data
    # En data/raw/ hay al menos PopUpLateral.mov en este repo.
    assert any(v.lower().endswith(".mov") for v in data["videos"])
```

- [ ] **Step 4: Correr el test y verificar que falla**

Run: `./venv/bin/pytest tests/test_server.py::test_list_videos_returns_existing_raw_videos -v`
Expected: FAIL con `ModuleNotFoundError: No module named 'webtool'`.

- [ ] **Step 5: Implementar el scaffold mínimo**

Create `webtool/__init__.py` (vacío). Create `webtool/server.py`:

```python
"""Servidor Flask del motor visual de etiquetado (Fase 0, soporte de validación).

Sirve frames de video, landmarks de MediaPipe y persiste anotaciones a JSON.
Arranca con: ./venv/bin/python -m webtool.server
"""
from __future__ import annotations

import os

from flask import Flask, jsonify, send_from_directory

RAW_DIR = "data/raw"
OUTPUT_DIR = "data/output"
VIDEO_EXTS = (".mov", ".mp4", ".avi", ".mkv")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


def list_videos() -> list[str]:
    if not os.path.isdir(RAW_DIR):
        return []
    return sorted(
        f for f in os.listdir(RAW_DIR) if f.lower().endswith(VIDEO_EXTS)
    )


def create_app() -> Flask:
    app = Flask(__name__, static_folder=None)

    @app.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    @app.get("/static/<path:filename>")
    def static_files(filename: str):
        return send_from_directory(STATIC_DIR, filename)

    @app.get("/api/videos")
    def api_videos():
        return jsonify(videos=list_videos())

    return app


if __name__ == "__main__":
    create_app().run(host="127.0.0.1", port=5000, debug=True)
```

- [ ] **Step 6: Correr el test y verificar que pasa**

Run: `./venv/bin/pytest tests/test_server.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add requirements.txt conftest.py webtool/ tests/
git commit -m "feat(webtool): scaffold Flask app + GET /api/videos"
```

---

### Task 2: `GET /api/meta/<video>`

**Files:**
- Modify: `webtool/server.py`
- Test: `tests/test_server.py`

**Interfaces:**
- Consumes: `src.pose.extract_landmarks` (solo para meta si no hay `.npy`).
- Produces: `GET /api/meta/<video> -> {fps, n_frames, width, height, has_landmarks}`.
  Usa OpenCV directo para fps/n_frames/width/height (rápido, sin correr MediaPipe).
  `has_landmarks` = existe `data/output/<stem>_landmarks.npy`. 404 si el video no existe.

- [ ] **Step 1: Escribir el test que falla**

Añadir a `tests/test_server.py`:

```python
def test_meta_returns_video_dimensions(client):
    resp = client.get("/api/meta/PopUpLateral.mov")
    assert resp.status_code == 200
    m = resp.get_json()
    assert m["n_frames"] > 0
    assert m["width"] > 0 and m["height"] > 0
    assert m["fps"] > 0
    assert isinstance(m["has_landmarks"], bool)


def test_meta_unknown_video_404(client):
    resp = client.get("/api/meta/nope.mov")
    assert resp.status_code == 404
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `./venv/bin/pytest tests/test_server.py::test_meta_returns_video_dimensions -v`
Expected: FAIL con 404 (ruta inexistente).

- [ ] **Step 3: Implementar**

Añadir imports al tope de `webtool/server.py`:

```python
import cv2
from flask import abort
```

Añadir helper y ruta dentro de `webtool/server.py` (helper a nivel módulo; ruta dentro de `create_app`):

```python
def video_path(video: str) -> str:
    """Path seguro a un video de data/raw/, o 404 si no existe."""
    if "/" in video or "\\" in video or not video.lower().endswith(VIDEO_EXTS):
        abort(404)
    path = os.path.join(RAW_DIR, video)
    if not os.path.isfile(path):
        abort(404)
    return path


def landmarks_npy_path(video: str) -> str:
    stem = os.path.splitext(video)[0]
    return os.path.join(OUTPUT_DIR, f"{stem}_landmarks.npy")


def read_meta(path: str) -> dict:
    cap = cv2.VideoCapture(path)
    cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    ok, frame = cap.read()  # dims reales tras auto-orientación
    if ok:
        height, width = frame.shape[:2]
    else:
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()
    return {"fps": fps, "n_frames": n_frames, "width": width, "height": height}
```

Dentro de `create_app`, añadir:

```python
    @app.get("/api/meta/<video>")
    def api_meta(video: str):
        path = video_path(video)
        meta = read_meta(path)
        meta["has_landmarks"] = os.path.isfile(landmarks_npy_path(video))
        return jsonify(meta)
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `./venv/bin/pytest tests/test_server.py -v`
Expected: PASS (ambos tests de meta).

- [ ] **Step 5: Commit**

```bash
git add webtool/server.py tests/test_server.py
git commit -m "feat(webtool): GET /api/meta/<video>"
```

---

### Task 3: Servido de frames `GET /api/frame/<video>/<n>`

**Files:**
- Create: `webtool/frames.py`
- Modify: `webtool/server.py`
- Test: `tests/test_server.py`

**Interfaces:**
- Produces: `webtool.frames.FrameReader` — clase con `get_jpeg(video_path: str, n: int) -> bytes`
  que mantiene un `cv2.VideoCapture` abierto por video (orientación-auto) y un cache LRU de
  hasta 64 frames JPEG keyed por `(video_path, n)`. Ruta `GET /api/frame/<video>/<n>` devuelve
  `image/jpeg`. `n` se clampa a `[0, n_frames-1]`.

- [ ] **Step 1: Escribir el test que falla**

Añadir a `tests/test_server.py`:

```python
def test_frame_returns_jpeg(client):
    resp = client.get("/api/frame/PopUpLateral.mov/0")
    assert resp.status_code == 200
    assert resp.mimetype == "image/jpeg"
    # JPEG empieza con los magic bytes FF D8.
    assert resp.data[:2] == b"\xff\xd8"


def test_frame_out_of_range_clamps(client):
    resp = client.get("/api/frame/PopUpLateral.mov/999999")
    assert resp.status_code == 200
    assert resp.data[:2] == b"\xff\xd8"
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `./venv/bin/pytest tests/test_server.py::test_frame_returns_jpeg -v`
Expected: FAIL con 404.

- [ ] **Step 3: Implementar `webtool/frames.py`**

```python
"""Lectura de frames de video on-demand con cache LRU, para el motor visual.

Mantiene un VideoCapture abierto por video (con orientación-auto, igual que pose.py)
y cachea los últimos frames codificados a JPEG para que la navegación ◀▶ sea fluida.
"""
from __future__ import annotations

from collections import OrderedDict

import cv2

CACHE_SIZE = 64
JPEG_QUALITY = 85


class FrameReader:
    def __init__(self) -> None:
        self._caps: dict[str, cv2.VideoCapture] = {}
        self._counts: dict[str, int] = {}
        self._cache: "OrderedDict[tuple[str, int], bytes]" = OrderedDict()

    def _cap(self, path: str) -> cv2.VideoCapture:
        cap = self._caps.get(path)
        if cap is None:
            cap = cv2.VideoCapture(path)
            cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
            self._caps[path] = cap
            self._counts[path] = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        return cap

    def get_jpeg(self, path: str, n: int) -> bytes:
        cap = self._cap(path)
        total = self._counts[path]
        n = max(0, min(n, total - 1))
        key = (path, n)
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        cap.set(cv2.CAP_PROP_POS_FRAMES, n)
        ok, frame = cap.read()
        if not ok:
            raise IndexError(f"No se pudo leer el frame {n} de {path}")
        ok, buf = cv2.imencode(
            ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY]
        )
        data = buf.tobytes()
        self._cache[key] = data
        self._cache.move_to_end(key)
        if len(self._cache) > CACHE_SIZE:
            self._cache.popitem(last=False)
        return data
```

- [ ] **Step 4: Cablear la ruta en `webtool/server.py`**

Añadir import al tope:

```python
from flask import Response
from webtool.frames import FrameReader
```

Dentro de `create_app`, antes de las rutas, crear un reader compartido y la ruta:

```python
    reader = FrameReader()

    @app.get("/api/frame/<video>/<int:n>")
    def api_frame(video: str, n: int):
        path = video_path(video)
        jpeg = reader.get_jpeg(path, n)
        return Response(jpeg, mimetype="image/jpeg")
```

- [ ] **Step 5: Correr y verificar que pasa**

Run: `./venv/bin/pytest tests/test_server.py -v`
Expected: PASS (todos).

- [ ] **Step 6: Commit**

```bash
git add webtool/frames.py webtool/server.py tests/test_server.py
git commit -m "feat(webtool): frame serving on-demand con cache LRU"
```

---

### Task 4: `GET /api/landmarks/<video>`

**Files:**
- Modify: `webtool/server.py`
- Test: `tests/test_server.py`

**Interfaces:**
- Produces: `GET /api/landmarks/<video> -> {"landmarks": [[ [x,y,z,vis], ...33... ], ...n... ],
  "n_frames": int}`. Lee del `.npy` si existe; si no, llama `extract_landmarks` y guarda el
  `.npy`. NaN se serializan como `null` (JSON válido). Coords ya normalizadas 0-1.

- [ ] **Step 1: Escribir el test que falla**

Añadir a `tests/test_server.py`:

```python
def test_landmarks_shape(client):
    resp = client.get("/api/landmarks/PopUpLateral.mov")
    assert resp.status_code == 200
    data = resp.get_json()
    lm = data["landmarks"]
    assert data["n_frames"] == len(lm)
    assert len(lm[0]) == 33          # 33 landmarks
    assert len(lm[0][0]) == 4        # x,y,z,vis
    # Coords normalizadas: x del landmark 0 dentro de un margen razonable.
    assert -0.5 < lm[0][0][0] < 1.5
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `./venv/bin/pytest tests/test_server.py::test_landmarks_shape -v`
Expected: FAIL con 404.

- [ ] **Step 3: Implementar**

Añadir import al tope de `webtool/server.py`:

```python
import numpy as np
from src import pose
```

Helper a nivel módulo:

```python
def load_or_extract_landmarks(video: str) -> np.ndarray:
    npy = landmarks_npy_path(video)
    if os.path.isfile(npy):
        return np.load(npy)
    lm, _ = pose.extract_landmarks(os.path.join(RAW_DIR, video))
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    np.save(npy, lm)
    return lm
```

Ruta dentro de `create_app`:

```python
    @app.get("/api/landmarks/<video>")
    def api_landmarks(video: str):
        video_path(video)  # valida existencia / 404
        lm = load_or_extract_landmarks(video)
        # NaN -> None para JSON válido.
        clean = np.where(np.isnan(lm), None, lm).tolist()
        return jsonify(landmarks=clean, n_frames=len(clean))
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `./venv/bin/pytest tests/test_server.py::test_landmarks_shape -v`
Expected: PASS (el `.npy` de PopUpLateral ya existe → no corre MediaPipe).

- [ ] **Step 5: Commit**

```bash
git add webtool/server.py tests/test_server.py
git commit -m "feat(webtool): GET /api/landmarks/<video>"
```

---

### Task 5: Anotaciones `GET`/`POST /api/annotations/<video>`

**Files:**
- Modify: `webtool/server.py`
- Test: `tests/test_server.py`

**Interfaces:**
- Produces:
  - `GET /api/annotations/<video> -> dict` (el JSON guardado, o
    `{"video": v, "corrections": {}, "angles": [], "drawings": {}}` si no hay archivo).
  - `POST /api/annotations/<video>` con body JSON → escribe
    `data/output/<stem>_annotations.json`, devuelve `{"ok": true}`.

- [ ] **Step 1: Escribir el test que falla**

Añadir a `tests/test_server.py`:

```python
def test_annotations_roundtrip(client, tmp_path, monkeypatch):
    import webtool.server as srv
    monkeypatch.setattr(srv, "OUTPUT_DIR", str(tmp_path))

    payload = {
        "video": "PopUpLateral.mov",
        "corrections": {"151": {"25": [0.41, 0.72]}},
        "angles": [{"frame": 151, "points": [[0.4, 0.3], [0.4, 0.7], [0.39, 0.95]],
                    "value": 129.3, "label": "rodilla"}],
        "drawings": {"151": [{"tool": "pen", "stroke": [[0.5, 0.5]], "color": "#ff0000"}]},
    }
    post = client.post("/api/annotations/PopUpLateral.mov", json=payload)
    assert post.status_code == 200
    assert post.get_json()["ok"] is True

    got = client.get("/api/annotations/PopUpLateral.mov").get_json()
    assert got["corrections"]["151"]["25"] == [0.41, 0.72]
    assert got["angles"][0]["value"] == 129.3


def test_annotations_empty_default(client, tmp_path, monkeypatch):
    import webtool.server as srv
    monkeypatch.setattr(srv, "OUTPUT_DIR", str(tmp_path))
    got = client.get("/api/annotations/PopUpLateral.mov").get_json()
    assert got["corrections"] == {}
    assert got["angles"] == []
    assert got["drawings"] == {}
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `./venv/bin/pytest tests/test_server.py::test_annotations_roundtrip -v`
Expected: FAIL con 404.

- [ ] **Step 3: Implementar**

Añadir import al tope de `webtool/server.py`:

```python
import json
from flask import request
```

Helper a nivel módulo:

```python
def annotations_path(video: str) -> str:
    stem = os.path.splitext(video)[0]
    return os.path.join(OUTPUT_DIR, f"{stem}_annotations.json")
```

Rutas dentro de `create_app` (referenciar `srv.OUTPUT_DIR` vía la función helper que lee el
módulo en runtime; los helpers usan la constante de módulo, que el test parchea con monkeypatch):

```python
    @app.get("/api/annotations/<video>")
    def api_get_annotations(video: str):
        video_path(video)  # 404 si no existe el video
        path = annotations_path(video)
        if os.path.isfile(path):
            with open(path) as f:
                return jsonify(json.load(f))
        return jsonify(video=video, corrections={}, angles=[], drawings={})

    @app.post("/api/annotations/<video>")
    def api_post_annotations(video: str):
        video_path(video)
        data = request.get_json(force=True)
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        with open(annotations_path(video), "w") as f:
            json.dump(data, f, indent=2)
        return jsonify(ok=True)
```

Nota: `annotations_path` y la ruta POST leen `OUTPUT_DIR` del módulo en cada llamada, así
el `monkeypatch.setattr(srv, "OUTPUT_DIR", ...)` del test surte efecto. Para garantizarlo,
`annotations_path` debe referenciar la global del módulo (no capturar una copia local).

- [ ] **Step 4: Correr y verificar que pasa**

Run: `./venv/bin/pytest tests/test_server.py -v`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add webtool/server.py tests/test_server.py
git commit -m "feat(webtool): GET/POST /api/annotations/<video>"
```

---

### Task 6: Frontend shell — selección de video, navegación frame-a-frame, capa base

**Files:**
- Create: `webtool/static/index.html`
- Create: `webtool/static/style.css`
- Create: `webtool/static/app.js`

**Interfaces:**
- Consumes: `/api/videos`, `/api/meta/<v>`, `/api/frame/<v>/<n>`.
- Produces: estado global JS `{ video, frame, meta }`, función `showFrame(n)` que actualiza
  la imagen base y el label de frame; `<canvas id="base">` y `<canvas id="overlay">` apilados.

- [ ] **Step 1: Crear `webtool/static/index.html`**

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Surf Pop-Up — Etiquetado</title>
  <link rel="stylesheet" href="/static/style.css">
</head>
<body>
  <header>
    <select id="videoSelect"></select>
    <label><input type="checkbox" id="skeletonToggle" checked> esqueleto</label>
    <span class="tools">
      <button data-tool="none" class="active">cursor</button>
      <button data-tool="landmark">corregir</button>
      <button data-tool="angle">ángulo</button>
      <button data-tool="pen">dibujo</button>
      <button id="undoBtn">undo</button>
      <button id="clearBtn">clear frame</button>
      <button id="saveBtn">guardar</button>
    </span>
    <span id="status"></span>
  </header>

  <div id="stage">
    <canvas id="base"></canvas>
    <canvas id="overlay"></canvas>
  </div>

  <footer>
    <button id="prevBtn">◀</button>
    <input type="range" id="slider" min="0" value="0">
    <button id="nextBtn">▶</button>
    <input type="number" id="frameInput" min="0" value="0" style="width:6em">
    <span id="frameLabel">0 / 0</span>
  </footer>

  <script src="/static/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Crear `webtool/static/style.css`**

```css
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: #1e1e24; color: #eee; }
header, footer { display: flex; gap: 8px; align-items: center; padding: 8px 12px;
  background: #2a2a32; flex-wrap: wrap; }
header .tools { display: flex; gap: 4px; }
button { background: #3a3a44; color: #eee; border: 1px solid #555; border-radius: 4px;
  padding: 4px 10px; cursor: pointer; }
button.active { background: #4a78c0; border-color: #6a98e0; }
#stage { position: relative; display: inline-block; margin: 12px; }
#stage canvas { position: absolute; top: 0; left: 0; }
#base { position: relative; }
#overlay { cursor: crosshair; }
#slider { flex: 1; }
#status { margin-left: auto; color: #8c8; }
```

- [ ] **Step 3: Crear `webtool/static/app.js` (shell: video select + navegación + base)**

```javascript
// Estado global del motor visual.
const state = {
  video: null,
  frame: 0,
  meta: null,        // {fps, n_frames, width, height, has_landmarks}
};

const base = document.getElementById("base");
const overlay = document.getElementById("overlay");
const bctx = base.getContext("2d");
const octx = overlay.getContext("2d");

const els = {
  videoSelect: document.getElementById("videoSelect"),
  slider: document.getElementById("slider"),
  frameInput: document.getElementById("frameInput"),
  frameLabel: document.getElementById("frameLabel"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  status: document.getElementById("status"),
};

async function loadVideos() {
  const r = await fetch("/api/videos");
  const { videos } = await r.json();
  els.videoSelect.innerHTML = "";
  for (const v of videos) {
    const opt = document.createElement("option");
    opt.value = opt.textContent = v;
    els.videoSelect.appendChild(opt);
  }
  if (videos.length) await selectVideo(videos[0]);
}

async function selectVideo(video) {
  state.video = video;
  const r = await fetch(`/api/meta/${encodeURIComponent(video)}`);
  state.meta = await r.json();
  // Dimensionar ambos canvas al tamaño real del frame.
  for (const c of [base, overlay]) {
    c.width = state.meta.width;
    c.height = state.meta.height;
  }
  els.slider.max = state.meta.n_frames - 1;
  els.frameInput.max = state.meta.n_frames - 1;
  await showFrame(0);
}

async function showFrame(n) {
  if (!state.meta) return;
  n = Math.max(0, Math.min(n, state.meta.n_frames - 1));
  state.frame = n;
  els.slider.value = n;
  els.frameInput.value = n;
  els.frameLabel.textContent = `${n} / ${state.meta.n_frames - 1}`;
  const img = new Image();
  img.onload = () => {
    bctx.drawImage(img, 0, 0, base.width, base.height);
    redrawOverlay();   // definido en tasks posteriores
  };
  img.src = `/api/frame/${encodeURIComponent(state.video)}/${n}`;
}

// Placeholder hasta Task 7+; se redefine al añadir overlays.
function redrawOverlay() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
}

els.videoSelect.addEventListener("change", (e) => selectVideo(e.target.value));
els.prevBtn.addEventListener("click", () => showFrame(state.frame - 1));
els.nextBtn.addEventListener("click", () => showFrame(state.frame + 1));
els.slider.addEventListener("input", (e) => showFrame(+e.target.value));
els.frameInput.addEventListener("change", (e) => showFrame(+e.target.value));
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "ArrowLeft") showFrame(state.frame - 1);
  if (e.key === "ArrowRight") showFrame(state.frame + 1);
});

loadVideos();
```

- [ ] **Step 4: Verificación manual**

Run: `./venv/bin/python -m webtool.server`
Abrir `http://127.0.0.1:5000`. Expected: dropdown con los videos; el primer frame de
PopUpLateral se muestra; ◀▶, slider, input de frame y flechas del teclado cambian el frame.

- [ ] **Step 5: Commit**

```bash
git add webtool/static/
git commit -m "feat(webtool): frontend shell con navegación frame-a-frame"
```

---

### Task 7: Overlay de esqueleto MediaPipe + toggle

**Files:**
- Modify: `webtool/static/app.js`

**Interfaces:**
- Consumes: `/api/landmarks/<v>`, `state.frame`, `state.meta`.
- Produces: `state.landmarks` (array `[n][33][4]` con `null` en NaN), `getPoint(frame, idx) ->
  {x,y}|null` (en px de canvas, aplicando correcciones si existen), `drawSkeleton()`. Redefine
  `redrawOverlay()` para incluir el esqueleto cuando el toggle está activo.

- [ ] **Step 1: Cargar landmarks al seleccionar video**

En `selectVideo`, después de setear `state.meta`, añadir:

```javascript
  const lr = await fetch(`/api/landmarks/${encodeURIComponent(video)}`);
  state.landmarks = (await lr.json()).landmarks;
  state.annotations = await (await fetch(
    `/api/annotations/${encodeURIComponent(video)}`)).json();
```

Y declarar en `state` (al tope): `landmarks: null, annotations: null,`.

- [ ] **Step 2: Conexiones del esqueleto y helpers de dibujo**

Añadir a `app.js`:

```javascript
// Pares de landmarks a conectar (subconjunto relevante del pop-up).
const BONES = [
  [11, 13], [13, 15], [12, 14], [14, 16],        // brazos
  [11, 12], [23, 24], [11, 23], [12, 24],         // torso
  [23, 25], [25, 27], [24, 26], [26, 28],         // piernas
];

// Devuelve el punto en px de canvas para (frame, idx), con corrección si existe, o null.
function getPoint(frame, idx) {
  const corr = state.annotations?.corrections?.[frame]?.[idx];
  if (corr) return { x: corr[0] * overlay.width, y: corr[1] * overlay.height };
  const lm = state.landmarks?.[frame]?.[idx];
  if (!lm || lm[0] === null) return null;
  return { x: lm[0] * overlay.width, y: lm[1] * overlay.height };
}

function drawSkeleton() {
  const f = state.frame;
  octx.lineWidth = 2;
  octx.strokeStyle = "#39d";
  for (const [a, b] of BONES) {
    const pa = getPoint(f, a), pb = getPoint(f, b);
    if (!pa || !pb) continue;
    octx.beginPath();
    octx.moveTo(pa.x, pa.y); octx.lineTo(pb.x, pb.y); octx.stroke();
  }
  octx.fillStyle = "#fd3";
  for (let i = 0; i < 33; i++) {
    const p = getPoint(f, i);
    if (!p) continue;
    octx.beginPath(); octx.arc(p.x, p.y, 4, 0, 2 * Math.PI); octx.fill();
  }
}
```

- [ ] **Step 3: Redefinir `redrawOverlay` y cablear el toggle**

Reemplazar la función `redrawOverlay` placeholder por:

```javascript
function redrawOverlay() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (document.getElementById("skeletonToggle").checked) drawSkeleton();
}

document.getElementById("skeletonToggle")
  .addEventListener("change", redrawOverlay);
```

- [ ] **Step 4: Verificación manual**

Run: `./venv/bin/python -m webtool.server`; abrir el sitio.
Expected: el esqueleto azul/amarillo se dibuja sobre la persona y sigue el movimiento al
avanzar frames; el checkbox "esqueleto" lo muestra/oculta.

- [ ] **Step 5: Commit**

```bash
git add webtool/static/app.js
git commit -m "feat(webtool): overlay de esqueleto MediaPipe con toggle"
```

---

### Task 8: Herramienta corregir-landmark (drag)

**Files:**
- Modify: `webtool/static/app.js`

**Interfaces:**
- Consumes: `state.frame`, `getPoint`, `state.annotations.corrections`.
- Produces: selección de herramienta vía `state.tool`; al arrastrar un punto cercano,
  escribe `state.annotations.corrections[frame][idx] = [x_norm, y_norm]` y redibuja.

- [ ] **Step 1: Manejo de selección de herramienta**

Añadir a `app.js`:

```javascript
state.tool = "none";
document.querySelectorAll("header .tools button[data-tool]").forEach((b) => {
  b.addEventListener("click", () => {
    state.tool = b.dataset.tool;
    document.querySelectorAll("header .tools button[data-tool]")
      .forEach((x) => x.classList.toggle("active", x === b));
  });
});

// px de canvas a partir de un evento de mouse (ajusta por escala de display).
function evtPos(e) {
  const r = overlay.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (overlay.width / r.width),
    y: (e.clientY - r.top) * (overlay.height / r.height),
  };
}
```

- [ ] **Step 2: Lógica de drag para corregir landmark**

Añadir a `app.js`:

```javascript
let dragIdx = null;

function nearestLandmark(pos, maxDist = 18) {
  let best = null, bestD = maxDist;
  for (let i = 0; i < 33; i++) {
    const p = getPoint(state.frame, i);
    if (!p) continue;
    const d = Math.hypot(p.x - pos.x, p.y - pos.y);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

overlay.addEventListener("mousedown", (e) => {
  if (state.tool !== "landmark") return;
  dragIdx = nearestLandmark(evtPos(e));
});

overlay.addEventListener("mousemove", (e) => {
  if (state.tool !== "landmark" || dragIdx === null) return;
  const pos = evtPos(e);
  const f = state.frame;
  state.annotations.corrections[f] = state.annotations.corrections[f] || {};
  state.annotations.corrections[f][dragIdx] =
    [pos.x / overlay.width, pos.y / overlay.height];
  redrawOverlay();
});

window.addEventListener("mouseup", () => { dragIdx = null; });
```

- [ ] **Step 3: Verificación manual**

Run el server; herramienta "corregir"; arrastrar un punto del esqueleto.
Expected: el punto sigue al cursor y se queda en la nueva posición; al cambiar de frame y
volver, la corrección persiste en memoria (se guarda con "guardar", Task 11).

- [ ] **Step 4: Commit**

```bash
git add webtool/static/app.js
git commit -m "feat(webtool): herramienta corregir-landmark con drag"
```

---

### Task 9: Herramienta ángulo manual (3 clicks)

**Files:**
- Modify: `webtool/static/app.js`

**Interfaces:**
- Consumes: `state.frame`, `state.annotations.angles`, `evtPos`.
- Produces: tras 3 clicks (A, vértice B, C) crea
  `{frame, points:[[xn,yn]x3], value:deg, label}` en `state.annotations.angles` y lo dibuja.
  `angleDeg(a,b,c)` calcula el ángulo en B con arccos del producto punto (igual que metrics).

- [ ] **Step 1: Cálculo y dibujo de ángulos**

Añadir a `app.js`:

```javascript
let anglePts = [];   // acumula clicks A,B,C en px

function angleDeg(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const den = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) + 1e-9;
  return Math.acos(Math.max(-1, Math.min(1, dot / den))) * 180 / Math.PI;
}

function drawAngles() {
  octx.strokeStyle = "#6f6";
  octx.fillStyle = "#6f6";
  octx.font = "16px sans-serif";
  for (const a of state.annotations.angles) {
    if (a.frame !== state.frame) continue;
    const pts = a.points.map((p) => ({ x: p[0] * overlay.width, y: p[1] * overlay.height }));
    octx.beginPath();
    octx.moveTo(pts[0].x, pts[0].y);
    octx.lineTo(pts[1].x, pts[1].y);
    octx.lineTo(pts[2].x, pts[2].y);
    octx.stroke();
    octx.fillText(`${a.value.toFixed(0)}°`, pts[1].x + 8, pts[1].y - 8);
  }
}
```

- [ ] **Step 2: Captura de clicks**

Añadir a `app.js`:

```javascript
overlay.addEventListener("click", (e) => {
  if (state.tool !== "angle") return;
  anglePts.push(evtPos(e));
  if (anglePts.length === 3) {
    const [a, b, c] = anglePts;
    state.annotations.angles.push({
      frame: state.frame,
      points: anglePts.map((p) => [p.x / overlay.width, p.y / overlay.height]),
      value: angleDeg(a, b, c),
      label: "",
    });
    anglePts = [];
    redrawOverlay();
  }
});
```

- [ ] **Step 3: Incluir ángulos en el redibujo**

Actualizar `redrawOverlay`:

```javascript
function redrawOverlay() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (document.getElementById("skeletonToggle").checked) drawSkeleton();
  drawAngles();
  drawPenStrokes();   // definido en Task 10
}
```

(Si Task 10 aún no está, definir temporalmente `function drawPenStrokes(){}` para no romper;
Task 10 la reemplaza.)

- [ ] **Step 4: Verificación manual**

Server corriendo; herramienta "ángulo"; clickear cadera, rodilla, tobillo.
Expected: se dibuja la línea quebrada verde y los grados junto al vértice; comparar contra el
ángulo que reporta `phases.py`/`metrics.py` para ese frame.

- [ ] **Step 5: Commit**

```bash
git add webtool/static/app.js
git commit -m "feat(webtool): herramienta de ángulo manual (3 clicks)"
```

---

### Task 10: Dibujo libre + undo + clear

**Files:**
- Modify: `webtool/static/app.js`

**Interfaces:**
- Consumes: `state.frame`, `state.annotations.drawings`, `evtPos`.
- Produces: trazos `{tool:"pen", stroke:[[xn,yn]...], color}` en
  `state.annotations.drawings[frame]`; `drawPenStrokes()`; undo (saca el último ítem añadido
  en el frame) y clear (vacía anotaciones del frame).

- [ ] **Step 1: Dibujo de trazos**

Reemplazar el placeholder `drawPenStrokes` (o añadirlo) en `app.js`:

```javascript
const PEN_COLOR = "#f33";

function drawPenStrokes() {
  const strokes = state.annotations.drawings[state.frame] || [];
  octx.lineWidth = 3;
  octx.lineCap = "round";
  for (const s of strokes) {
    octx.strokeStyle = s.color || PEN_COLOR;
    octx.beginPath();
    s.stroke.forEach((p, i) => {
      const x = p[0] * overlay.width, y = p[1] * overlay.height;
      if (i === 0) octx.moveTo(x, y); else octx.lineTo(x, y);
    });
    octx.stroke();
  }
}
```

- [ ] **Step 2: Captura del trazo**

Añadir a `app.js`:

```javascript
let penStroke = null;

overlay.addEventListener("mousedown", (e) => {
  if (state.tool !== "pen") return;
  penStroke = { tool: "pen", stroke: [], color: PEN_COLOR };
  const f = state.frame;
  state.annotations.drawings[f] = state.annotations.drawings[f] || [];
  state.annotations.drawings[f].push(penStroke);
});

overlay.addEventListener("mousemove", (e) => {
  if (state.tool !== "pen" || !penStroke) return;
  const p = evtPos(e);
  penStroke.stroke.push([p.x / overlay.width, p.y / overlay.height]);
  redrawOverlay();
});

window.addEventListener("mouseup", () => { penStroke = null; });
```

- [ ] **Step 3: Undo y clear del frame**

Añadir a `app.js`:

```javascript
document.getElementById("undoBtn").addEventListener("click", () => {
  const f = state.frame;
  const d = state.annotations.drawings[f];
  if (d && d.length) { d.pop(); redrawOverlay(); return; }
  // si no hay trazos, deshacer el último ángulo de este frame
  const idx = [...state.annotations.angles].reverse().findIndex((a) => a.frame === f);
  if (idx >= 0) {
    state.annotations.angles.splice(state.annotations.angles.length - 1 - idx, 1);
    redrawOverlay();
  }
});

document.getElementById("clearBtn").addEventListener("click", () => {
  const f = state.frame;
  delete state.annotations.drawings[f];
  delete state.annotations.corrections[f];
  state.annotations.angles = state.annotations.angles.filter((a) => a.frame !== f);
  redrawOverlay();
});
```

- [ ] **Step 4: Verificación manual**

Server corriendo; herramienta "dibujo"; trazar líneas; "undo" saca el último trazo;
"clear frame" borra todo lo del frame.
Expected: comportamiento descrito; los trazos solo aparecen en su frame.

- [ ] **Step 5: Commit**

```bash
git add webtool/static/app.js
git commit -m "feat(webtool): dibujo libre + undo + clear por frame"
```

---

### Task 11: Guardar/cargar + smoke test con puppeteer

**Files:**
- Modify: `webtool/static/app.js`
- Create: `webtool/smoke_test.md`

**Interfaces:**
- Consumes: `state.annotations`, `POST /api/annotations/<v>`.
- Produces: botón "guardar" persiste `state.annotations`; al cargar un video se rehidratan las
  anotaciones guardadas (ya cargadas en Task 7 vía `/api/annotations`).

- [ ] **Step 1: Cablear guardar**

Añadir a `app.js`:

```javascript
document.getElementById("saveBtn").addEventListener("click", async () => {
  state.annotations.video = state.video;
  const r = await fetch(`/api/annotations/${encodeURIComponent(state.video)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.annotations),
  });
  els.status.textContent = (await r.json()).ok ? "guardado ✓" : "error";
  setTimeout(() => (els.status.textContent = ""), 2000);
});
```

- [ ] **Step 2: Asegurar estructura de anotaciones al cargar**

En `selectVideo`, tras setear `state.annotations`, normalizar claves faltantes:

```javascript
  state.annotations.corrections = state.annotations.corrections || {};
  state.annotations.angles = state.annotations.angles || [];
  state.annotations.drawings = state.annotations.drawings || {};
```

- [ ] **Step 3: Smoke test manual con puppeteer**

Crear `webtool/smoke_test.md` documentando el flujo y correrlo con la skill `puppeteer-test`
(o el MCP de puppeteer): con el server corriendo en `http://127.0.0.1:5000`:

```markdown
# Smoke test — motor visual de etiquetado

1. navegar a http://127.0.0.1:5000  → el dropdown tiene PopUpLateral.mov, frame 0 visible.
2. click ▶ 5 veces → frameLabel = "5 / 194", imagen cambia.
3. activar "ángulo", clickear 3 puntos → aparece arco verde con grados.
4. activar "dibujo", arrastrar → aparece trazo rojo.
5. click "guardar" → status muestra "guardado ✓".
6. recargar la página → las anotaciones del frame reaparecen.
7. verificar que existe data/output/PopUpLateral_annotations.json con corrections/angles/drawings.
```

Correr con puppeteer: navegar, screenshot tras cada paso, assert visual. Documentar resultado.

- [ ] **Step 4: Verificación final del backend**

Run: `./venv/bin/pytest tests/ -v`
Expected: todos los tests PASS.

- [ ] **Step 5: Commit**

```bash
git add webtool/static/app.js webtool/smoke_test.md
git commit -m "feat(webtool): guardar/cargar anotaciones + smoke test"
```

---

## Notas de integración (follow-up, fuera de v1)

- Un helper `apply_corrections(landmarks, annotations) -> landmarks` que overlaye
  `corrections` sobre el `.npy` para re-correr `phases.py`/`metrics.py` sobre landmarks
  corregidos. Diseñado pero no implementado en v1.
- Etiquetado de límites de fase: excluido (el usuario no lo pidió).
