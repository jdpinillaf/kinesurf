// Estado global del motor visual.
const state = {
  video: null,
  frame: 0,
  meta: null,        // {fps, n_frames, width, height, has_landmarks}
  landmarks: null,
  annotations: null,
  stride: 1,         // avanza N frames por paso / por tick de play
  playing: false,
  frameByFrame: false,  // play avanza lento, 1 frame a la vez
  ffDelay: 300,      // ms por frame en modo frame-a-frame
};
let _playToken = 0;  // cancela el loop de play en curso (pausa / nuevo play)

const base = document.getElementById("base");
const overlay = document.getElementById("overlay");
const bctx = base.getContext("2d");
const octx = overlay.getContext("2d");

const els = {
  videoSelect: document.getElementById("videoSelect"),
  slider: document.getElementById("slider"),
  frameInput: document.getElementById("frameInput"),
  frameLabel: document.getElementById("frameLabel"),
  playBtn: document.getElementById("playBtn"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  strideInput: document.getElementById("strideInput"),
  ffToggle: document.getElementById("ffToggle"),
  ffDelay: document.getElementById("ffDelay"),
  status: document.getElementById("status"),
};

async function loadVideos() {
  try {
    const r = await fetch("/api/videos");
    const { videos } = await r.json();
    els.videoSelect.innerHTML = "";
    for (const v of videos) {
      const opt = document.createElement("option");
      opt.value = opt.textContent = v;
      els.videoSelect.appendChild(opt);
    }
    if (videos.length) await selectVideo(videos[0]);
  } catch (err) {
    els.status.textContent = "error cargando: " + err.message;
  }
}

async function selectVideo(video) {
  if (state.playing) pause();   // cortar loop antes de cambiar de video
  try {
    state.video = video;
    const r = await fetch(`/api/meta/${encodeURIComponent(video)}`);
    state.meta = await r.json();
    const lr = await fetch(`/api/landmarks/${encodeURIComponent(video)}`);
    state.landmarks = (await lr.json()).landmarks;
    // Clamp navigable frame count to landmarks length.
    // iPhone .MOV files cause CAP_PROP_FRAME_COUNT to overestimate the
    // actual readable frames; MediaPipe only produces landmarks for the
    // frames it could decode, so landmarks.length is the true upper bound.
    // Guard: don't clamp when landmarks is empty (no pose detected).
    if (Array.isArray(state.landmarks) && state.landmarks.length > 0
        && state.landmarks.length < state.meta.n_frames) {
      state.meta.n_frames = state.landmarks.length;
    }
    state.annotations = await (await fetch(
      `/api/annotations/${encodeURIComponent(video)}`)).json();
    state.annotations.corrections = state.annotations.corrections || {};
    state.annotations.angles = state.annotations.angles || [];
    state.annotations.drawings = state.annotations.drawings || {};
    // Buffer de los canvas = resolución real del frame (dibujo nítido).
    // El tamaño en pantalla lo ajusta fitStage() vía CSS sobre .frame.
    for (const c of [base, overlay]) {
      c.width = state.meta.width;
      c.height = state.meta.height;
    }
    fitStage();
    els.slider.max = state.meta.n_frames - 1;
    els.frameInput.max = state.meta.n_frames - 1;
    await showFrame(0);
  } catch (err) {
    els.status.textContent = "error cargando: " + err.message;
  }
}

// Ajusta el tamaño en pantalla de .frame para que el video quepa dentro de
// #stage (math de "contain"), conservando la proporción. El buffer de los
// canvas queda en resolución nativa; evtPos ya corrige por la escala.
const stageEl = document.getElementById("stage");
const frameEl = document.querySelector("#stage .frame");
function fitStage() {
  if (!state.meta || !frameEl) return;
  const aw = stageEl.clientWidth, ah = stageEl.clientHeight;
  if (aw <= 0 || ah <= 0) return;
  const vr = state.meta.width / state.meta.height;
  let w = aw, h = w / vr;
  if (h > ah) { h = ah; w = h * vr; }
  frameEl.style.width = w + "px";
  frameEl.style.height = h + "px";
}
window.addEventListener("resize", fitStage);

let _frameSeq = 0;   // discards stale async frame loads (rapid nav)

async function showFrame(n) {
  if (!state.meta) return;
  anglePts = [];
  n = Math.max(0, Math.min(n, state.meta.n_frames - 1));
  state.frame = n;
  els.slider.value = n;
  els.frameInput.value = n;
  els.frameLabel.textContent = `${n} / ${state.meta.n_frames - 1}`;
  const seq = ++_frameSeq;
  await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (seq !== _frameSeq) return resolve();   // a newer frame was requested; drop this paint
      bctx.drawImage(img, 0, 0, base.width, base.height);
      redrawOverlay();
      resolve();
    };
    img.onerror = resolve;   // don't hang the promise on a failed load
    img.src = `/api/frame/${encodeURIComponent(state.video)}/${n}`;
  });
}

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

function redrawOverlay() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (document.getElementById("skeletonToggle").checked) drawSkeleton();
  drawAngles();
  drawPenStrokes();   // definido en Task 10
}

document.getElementById("skeletonToggle")
  .addEventListener("change", redrawOverlay);

// avanza/retrocede `stride` frames (pausa el play si está corriendo manualmente)
function step(dir) { showFrame(state.frame + dir * state.stride); }

// ── Play / pausa ──────────────────────────────────────────────────────────────
// Loop auto-agendado que ESPERA a que cada frame se pinte antes del siguiente.
// Con setInterval, si el JPEG tarda más que el intervalo el guard anti-stale
// descarta repintados y la imagen se ve congelada. Al await-ear showFrame() cada
// frame se pinta sí o sí; el ritmo se auto-ajusta (a lo sumo tiempo real).
async function play() {
  if (state.playing || !state.meta) return;
  state.playing = true;
  els.playBtn.textContent = "⏸ pausa";
  const token = ++_playToken;
  const hi = state.meta.n_frames - 1;
  const fps = state.meta.fps || 30;
  if (state.frame >= hi) await showFrame(0);   // reiniciar al inicio
  while (state.playing && token === _playToken) {
    const next = state.frame + state.stride;
    if (next > hi) { pause(); break; }
    const t0 = performance.now();
    await showFrame(next);                       // espera el pintado real
    if (token !== _playToken) break;             // pausado durante la carga
    const target = state.frameByFrame ? state.ffDelay : 1000 * state.stride / fps;
    const elapsed = performance.now() - t0;
    if (elapsed < target) await new Promise((r) => setTimeout(r, target - elapsed));
  }
}
function pause() {
  _playToken++;                  // cancela el loop en curso
  state.playing = false;
  els.playBtn.textContent = "▶ play";
}
function togglePlay() { state.playing ? pause() : play(); }

els.videoSelect.addEventListener("change", (e) => selectVideo(e.target.value));
els.playBtn.addEventListener("click", togglePlay);
els.prevBtn.addEventListener("click", () => step(-1));
els.nextBtn.addEventListener("click", () => step(1));
els.slider.addEventListener("input", (e) => showFrame(+e.target.value));
els.frameInput.addEventListener("change", (e) => showFrame(+e.target.value));
els.strideInput.addEventListener("change", (e) => {
  state.stride = Math.max(1, parseInt(e.target.value, 10) || 1);
  els.strideInput.value = state.stride;
});
els.ffToggle.addEventListener("change", (e) => { state.frameByFrame = e.target.checked; });
els.ffDelay.addEventListener("change", (e) => {
  state.ffDelay = Math.max(50, parseInt(e.target.value, 10) || 300);
  els.ffDelay.value = state.ffDelay;
});
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "ArrowLeft") step(-1);
  if (e.key === "ArrowRight") step(1);
  if (e.key === " ") { e.preventDefault(); togglePlay(); }
});

// ── Herramienta activa ────────────────────────────────────────────────────────
state.tool = "none";
document.querySelectorAll("header .tools button[data-tool]").forEach((b) => {
  b.addEventListener("click", () => {
    state.tool = b.dataset.tool;
    anglePts = [];
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

// ── Drag para corregir landmark ───────────────────────────────────────────────
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
  // Guard: corrections may be absent on the annotations object from the API.
  state.annotations.corrections = state.annotations.corrections || {};
  state.annotations.corrections[f] = state.annotations.corrections[f] || {};
  state.annotations.corrections[f][dragIdx] =
    [pos.x / overlay.width, pos.y / overlay.height];
  redrawOverlay();
});

window.addEventListener("mouseup", () => { dragIdx = null; });

// ── Herramienta de dibujo libre (pen) ────────────────────────────────────────
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

// ── Herramienta de ángulo manual (3 clicks: A, vértice B, C) ─────────────────
let anglePts = [];   // acumula clicks A,B,C en px

function angleDeg(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const den = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) + 1e-9;
  return Math.acos(Math.max(-1, Math.min(1, dot / den))) * 180 / Math.PI;
}

function drawAngles() {
  // Guard: annotations.angles may be absent before Task 11 normalizes it.
  if (!state.annotations?.angles) return;
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

overlay.addEventListener("click", (e) => {
  if (state.tool !== "angle") return;
  anglePts.push(evtPos(e));
  if (anglePts.length === 3) {
    const [a, b, c] = anglePts;
    // Guard: angles array may not exist yet.
    state.annotations.angles = state.annotations.angles || [];
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

// ── Guardar anotaciones ───────────────────────────────────────────────────────
document.getElementById("saveBtn").addEventListener("click", async () => {
  if (!state.video) return;
  state.annotations.video = state.video;
  try {
    const r = await fetch(`/api/annotations/${encodeURIComponent(state.video)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.annotations),
    });
    const ok = r.ok && (await r.json()).ok;
    els.status.textContent = ok ? "guardado ✓" : "error";
  } catch (err) {
    els.status.textContent = "error";
  }
  setTimeout(() => (els.status.textContent = ""), 2000);
});

// ── Undo y clear por frame ────────────────────────────────────────────────────
document.getElementById("undoBtn").addEventListener("click", () => {
  const f = state.frame;
  const d = state.annotations.drawings[f];
  if (d && d.length) { d.pop(); redrawOverlay(); return; }
  // si no hay trazos, deshacer el último ángulo de este frame
  const idx = [...(state.annotations.angles || [])].reverse().findIndex((a) => a.frame === f);
  if (idx >= 0) {
    state.annotations.angles.splice(state.annotations.angles.length - 1 - idx, 1);
    redrawOverlay();
  }
});

document.getElementById("clearBtn").addEventListener("click", () => {
  const f = state.frame;
  delete state.annotations.drawings[f];
  delete state.annotations.corrections[f];
  state.annotations.angles = (state.annotations.angles || []).filter((a) => a.frame !== f);
  redrawOverlay();
});

loadVideos();
