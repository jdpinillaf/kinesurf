// sequence.js — storyboard del movimiento: pasos clave (poses) profe vs alumno,
// alineados por columna, como infografía. Stick-figures dibujados desde los landmarks.

const BONES = [
  [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 12], [23, 24], [11, 23], [12, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
];

const PREVIEW_H = 200;   // alto del canvas de preview
const CELL_H = 150;      // alto de cada celda de la infografía

function valid(p) { return p && p[0] !== null && p[1] !== null; }

// Dibuja el esqueleto (stick-figure) de un frame (landmarks norm 0-1) en ctx WxH,
// encuadrando la pose a su bounding-box (centrada, lo más grande posible manteniendo
// proporción) para que todas las poses sean comparables sin importar dónde/qué tamaño
// estaba la persona en el frame.
function drawPose(ctx, lm, W, H) {
  ctx.clearRect(0, 0, W, H);
  if (!lm) return;
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, any = false;
  for (let i = 0; i < 33; i++) {
    const p = lm[i];
    if (!valid(p)) continue;
    any = true;
    minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]);
    miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]);
  }
  if (!any) return;
  const bw = Math.max(maxx - minx, 1e-3), bh = Math.max(maxy - miny, 1e-3);
  const pad = 0.12;
  const scale = Math.min(W * (1 - 2 * pad) / bw, H * (1 - 2 * pad) / bh);
  const ox = (W - bw * scale) / 2 - minx * scale;
  const oy = (H - bh * scale) / 2 - miny * scale;
  const X = (p) => p[0] * scale + ox;
  const Y = (p) => p[1] * scale + oy;

  ctx.lineWidth = 2;
  ctx.strokeStyle = "#39d";
  for (const [a, b] of BONES) {
    const pa = lm[a], pb = lm[b];
    if (!valid(pa) || !valid(pb)) continue;
    ctx.beginPath();
    ctx.moveTo(X(pa), Y(pa));
    ctx.lineTo(X(pb), Y(pb));
    ctx.stroke();
  }
  ctx.fillStyle = "#fd3";
  for (let i = 0; i < 33; i++) {
    const p = lm[i];
    if (!valid(p)) continue;
    ctx.beginPath();
    ctx.arc(X(p), Y(p), 3, 0, 2 * Math.PI);
    ctx.fill();
  }
}

// Esqueleto en coordenadas del FRAME (norm 0-1 → celda), para superponer sobre el
// video real (no encuadra a bbox: tiene que alinear con la imagen completa).
function drawSkeletonFrame(ctx, lm, W, H) {
  if (!lm) return;
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#39d";
  for (const [a, b] of BONES) {
    const pa = lm[a], pb = lm[b];
    if (!valid(pa) || !valid(pb)) continue;
    ctx.beginPath();
    ctx.moveTo(pa[0] * W, pa[1] * H);
    ctx.lineTo(pb[0] * W, pb[1] * H);
    ctx.stroke();
  }
  ctx.fillStyle = "#fd3";
  for (let i = 0; i < 33; i++) {
    const p = lm[i];
    if (!valid(p)) continue;
    ctx.beginPath();
    ctx.arc(p[0] * W, p[1] * H, 3, 0, 2 * Math.PI);
    ctx.fill();
  }
}

let viewMode = "skeleton";   // "skeleton" | "frame" | "both"

// Pinta una celda según el modo: esqueleto encuadrado, frame real, o frame + esqueleto.
function cellPaint(canvas, col, f) {
  const ctx = canvas.getContext("2d"), W = canvas.width, H = canvas.height;
  const lm = col.lm ? col.lm[f] : null;
  if (viewMode === "skeleton") { drawPose(ctx, lm, W, H); return; }
  ctx.clearRect(0, 0, W, H);
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0, W, H);
    if (viewMode === "both") drawSkeletonFrame(ctx, lm, W, H);
  };
  img.src = `/api/frame/${encodeURIComponent(col.video)}/${f}`;
}

const els = {
  nSteps: document.getElementById("nSteps"),
  viewMode: document.getElementById("viewMode"),
  autoBtn: document.getElementById("autoBtn"),
  saveBtn: document.getElementById("saveBtn"),
  status: document.getElementById("status"),
};

let selectedCol = -1;   // columna resaltada (comparar ese paso)

// ── Columna de un video (profe/alumno) ────────────────────────────────────────
function makeCol(rootId, rowId) {
  const root = document.getElementById(rootId);
  const row = document.getElementById(rowId).querySelector(".cells");
  const $ = (s) => root.querySelector(s);
  const c = {
    rootId, root, row,
    video: null, lm: null, meta: null, clips: [], clip: null,
    steps: [], cursor: 0,
    els: {
      videoSelect: $(".videoSelect"),
      clipSelect: $(".clipSelect"),
      preview: $(".preview"),
      slider: $(".slider"),
      frameLabel: $(".frameLabel"),
      addBtn: $(".addBtn"),
    },
  };
  const pctx = c.els.preview.getContext("2d");

  function aspect() { return c.meta ? c.meta.width / c.meta.height : 0.5625; }
  function bounds() {
    const max = (c.lm ? c.lm.length : 1) - 1;
    if (c.clip) return [Math.max(0, c.clip.start), Math.min(max, c.clip.end)];
    return [0, max];
  }

  function sizeCanvas(canvas, h) {
    canvas.height = h;
    canvas.width = Math.round(h * aspect());
  }

  let pvSeq = 0;
  function drawPreview() {
    const [lo, hi] = bounds();
    c.cursor = Math.max(lo, Math.min(c.cursor, hi));
    c.els.slider.value = c.cursor;
    c.els.frameLabel.textContent = `${c.cursor} / ${hi}`;
    const f = c.cursor, W = c.els.preview.width, H = c.els.preview.height;
    const lm = c.lm ? c.lm[f] : null;
    if (viewMode === "skeleton") { drawPose(pctx, lm, W, H); return; }
    const seq = ++pvSeq;               // descarta paints viejos al scrubbear
    pctx.clearRect(0, 0, W, H);
    const img = new Image();
    img.onload = () => {
      if (seq !== pvSeq) return;
      pctx.drawImage(img, 0, 0, W, H);
      if (viewMode === "both") drawSkeletonFrame(pctx, lm, W, H);
    };
    img.src = `/api/frame/${encodeURIComponent(c.video)}/${f}`;
  }

  function autoSample(n) {
    const [lo, hi] = bounds();
    n = Math.max(2, n);
    c.steps = [];
    for (let i = 0; i < n; i++) {
      c.steps.push(lo + Math.round(i * (hi - lo) / (n - 1)));
    }
  }

  function populateClips() {
    c.els.clipSelect.innerHTML = '<option value="">video completo</option>';
    c.clips.forEach((cl, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = `${cl.name} (${cl.start}–${cl.end})`;
      c.els.clipSelect.appendChild(o);
    });
  }

  async function load(video) {
    c.video = video;
    c.els.videoSelect.value = video;
    c.meta = await (await fetch(`/api/meta/${encodeURIComponent(video)}`)).json();
    c.lm = (await (await fetch(`/api/landmarks/${encodeURIComponent(video)}`)).json()).landmarks;
    c.clips = (await (await fetch(`/api/clips/${encodeURIComponent(video)}`)).json()).clips || [];
    const seq = await (await fetch(`/api/sequence/${encodeURIComponent(video)}`)).json();
    c.clip = null;
    populateClips();
    sizeCanvas(c.els.preview, PREVIEW_H);
    const [lo, hi] = bounds();
    c.els.slider.min = lo; c.els.slider.max = hi; c.cursor = lo;
    c.steps = (seq.steps && seq.steps.length) ? seq.steps.slice()
                                              : (autoSample(+els.nSteps.value), c.steps);
    drawPreview();
  }

  async function save() {
    if (!c.video) return false;
    try {
      const r = await fetch(`/api/sequence/${encodeURIComponent(c.video)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video: c.video, steps: c.steps }),
      });
      return r.ok && (await r.json()).ok;
    } catch (e) { return false; }
  }

  // listeners
  c.els.videoSelect.addEventListener("change", async (e) => {
    await load(e.target.value); renderInfographic();
  });
  c.els.clipSelect.addEventListener("change", (e) => {
    const v = e.target.value;
    c.clip = v === "" ? null : (c.clips[+v] || null);
    const [lo, hi] = bounds();
    c.els.slider.min = lo; c.els.slider.max = hi;
    drawPreview();
  });
  c.els.slider.addEventListener("input", (e) => { c.cursor = +e.target.value; drawPreview(); });
  c.els.addBtn.addEventListener("click", () => {
    if (!c.steps.includes(c.cursor)) c.steps.push(c.cursor);
    c.steps.sort((a, b) => a - b);
    renderInfographic();
  });

  c.load = load;
  c.save = save;
  c.autoSample = autoSample;
  c.bounds = bounds;
  c.sizeCanvas = sizeCanvas;
  c.drawPreview = drawPreview;
  return c;
}

const colA = makeCol("colA", "rowA");
const colB = makeCol("colB", "rowB");

// ── Infografía: dos filas alineadas por columna ───────────────────────────────
function renderRow(col) {
  col.row.innerHTML = "";
  const n = Math.max(colA.steps.length, colB.steps.length);
  for (let i = 0; i < n; i++) {
    const cell = document.createElement("div");
    cell.className = "cell" + (i === selectedCol ? " sel" : "");
    cell.dataset.col = i;
    const f = col.steps[i];
    if (f === undefined) {
      // hueco para mantener columnas alineadas
      cell.style.visibility = "hidden";
      cell.style.width = Math.round(CELL_H * (col.meta ? col.meta.width / col.meta.height : 0.5625)) + "px";
      col.row.appendChild(cell);
      continue;
    }
    const no = document.createElement("span");
    no.className = "step-no"; no.textContent = i + 1;
    const rm = document.createElement("button");
    rm.className = "rm"; rm.textContent = "×";
    rm.title = "quitar paso";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      col.steps.splice(i, 1);
      renderInfographic();
    });
    const cv = document.createElement("canvas");
    col.sizeCanvas(cv, CELL_H);
    cellPaint(cv, col, f);
    const cf = document.createElement("span");
    cf.className = "cf"; cf.textContent = `f ${f}`;
    cell.appendChild(no); cell.appendChild(rm);
    cell.appendChild(cv); cell.appendChild(cf);
    cell.addEventListener("click", () => {
      selectedCol = (selectedCol === i ? -1 : i);
      renderInfographic();
    });
    col.row.appendChild(cell);
  }
}

function renderInfographic() {
  renderRow(colA);
  renderRow(colB);
}

// ── Controles globales ────────────────────────────────────────────────────────
els.viewMode.addEventListener("change", (e) => {
  viewMode = e.target.value;
  colA.drawPreview(); colB.drawPreview();
  renderInfographic();
});
els.autoBtn.addEventListener("click", () => {
  const n = +els.nSteps.value;
  colA.autoSample(n); colB.autoSample(n);
  selectedCol = -1;
  renderInfographic();
});
els.saveBtn.addEventListener("click", async () => {
  const okA = await colA.save();
  const okB = await colB.save();
  els.status.textContent = (okA && okB) ? "guardado ✓" : "error";
  setTimeout(() => (els.status.textContent = ""), 2000);
});

// ── Init ──────────────────────────────────────────────────────────────────────
function pick(videos, prefer, fallbackIdx) {
  const hit = videos.find((v) => v.toLowerCase().includes(prefer));
  return hit || videos[fallbackIdx] || videos[0] || null;
}

async function init() {
  const { videos } = await (await fetch("/api/videos")).json();
  for (const col of [colA, colB]) {
    col.els.videoSelect.innerHTML = "";
    for (const v of videos) {
      const o = document.createElement("option");
      o.value = o.textContent = v;
      col.els.videoSelect.appendChild(o);
    }
  }
  const vA = pick(videos, "profesor", 0);
  const vB = pick(videos, "estudiante", 1);
  if (vA) await colA.load(vA);
  if (vB) await colB.load(vB);
  renderInfographic();
}

init();
