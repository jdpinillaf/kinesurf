// sequence.js — storyboard del movimiento: pasos clave (poses) profe vs alumno,
// alineados por columna, como infografía. Stick-figures dibujados desde los landmarks.

const BONES = [
  [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 12], [23, 24], [11, 23], [12, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
];

const PREVIEW_H = 200;   // alto del canvas de preview
const CELL_H = 150;      // alto de cada celda de la infografía
const LOW_VIS = 0.5;     // visibility por debajo = punto poco confiable (ocluido)

function valid(p) { return p && p[0] !== null && p[1] !== null; }
function lowVis(p) { return p && p[3] != null && p[3] < LOW_VIS; }

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
  for (const [a, b] of BONES) {
    const pa = lm[a], pb = lm[b];
    if (!valid(pa) || !valid(pb)) continue;
    const est = isEstimated(pa) || isEstimated(pb);
    const low = lowVis(pa) || lowVis(pb);
    ctx.strokeStyle = est ? "rgba(34,211,238,.55)" : low ? "rgba(57,153,221,.35)" : "#39d";
    ctx.setLineDash(est || low ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(X(pa), Y(pa));
    ctx.lineTo(X(pb), Y(pb));
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (let i = 0; i < 33; i++) {
    const p = lm[i];
    if (!valid(p)) continue;
    if (isEstimated(p)) {
      ctx.strokeStyle = "#22d3ee"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(X(p), Y(p), 3.5, 0, 2 * Math.PI); ctx.stroke();
    } else if (lowVis(p)) {
      ctx.strokeStyle = "#ff8c1a"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(X(p), Y(p), 3.5, 0, 2 * Math.PI); ctx.stroke();
    } else {
      ctx.fillStyle = "#fd3";
      ctx.beginPath(); ctx.arc(X(p), Y(p), 3, 0, 2 * Math.PI); ctx.fill();
    }
  }
}

// Esqueleto en coordenadas del FRAME (norm 0-1 → celda), para superponer sobre el
// video real (no encuadra a bbox: tiene que alinear con la imagen completa).
function drawSkeletonFrame(ctx, lm, W, H) {
  if (!lm) return;
  ctx.lineWidth = 2;
  for (const [a, b] of BONES) {
    const pa = lm[a], pb = lm[b];
    if (!valid(pa) || !valid(pb)) continue;
    const est = isEstimated(pa) || isEstimated(pb);
    const low = lowVis(pa) || lowVis(pb);
    ctx.strokeStyle = est ? "rgba(34,211,238,.55)" : low ? "rgba(57,153,221,.35)" : "#39d";
    ctx.setLineDash(est || low ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(pa[0] * W, pa[1] * H);
    ctx.lineTo(pb[0] * W, pb[1] * H);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (let i = 0; i < 33; i++) {
    const p = lm[i];
    if (!valid(p)) continue;
    if (isEstimated(p)) {
      ctx.strokeStyle = "#22d3ee"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p[0] * W, p[1] * H, 3.5, 0, 2 * Math.PI); ctx.stroke();
    } else if (lowVis(p)) {
      ctx.strokeStyle = "#ff8c1a"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p[0] * W, p[1] * H, 3.5, 0, 2 * Math.PI); ctx.stroke();
    } else {
      ctx.fillStyle = "#fd3";
      ctx.beginPath(); ctx.arc(p[0] * W, p[1] * H, 3, 0, 2 * Math.PI); ctx.fill();
    }
  }
}

// Las notas/dibujos son INDIVIDUALES por representación: el esqueleto (vectores) y el
// video son cosas distintas. Clave = "<rep>:<frame>", con rep = "skeleton" o "frame"
// (el modo "both" comparte el dibujo del video porque muestra el frame debajo).
function repOf(mode) { return mode === "skeleton" ? "skeleton" : "frame"; }
function noteKey(mode, f) { return repOf(mode) + ":" + f; }
function noteFor(col, mode, f) { return col.notes ? col.notes[noteKey(mode, f)] : undefined; }

// Pinta anotaciones normalizadas (lápiz/flecha/texto) sobre ctx WxH (draw.js).
function paintStrokes(ctx, strokes, W, H) {
  drawAnnotationItems(ctx, strokes, W, H);
}

let viewMode = "skeleton";   // "skeleton" | "frame" | "both" | "split"
let showMetrics = true;      // ángulos por paso + Δ profe vs alumno
let showFill = true;         // usar landmarks con oclusiones rellenadas

// Array de landmarks activo de una columna: rellenado (si showFill) o crudo.
function colLm(col) { return (showFill && col.filled) ? col.filled : col.lm; }

// Métricas 2D+3D (metrics.js) del frame f de una columna.
function metricsFor(col, f) {
  if (!col.lm || !col.meta || f == null) return [];
  const La = colLm(col);
  const r2 = makeResolver(La[f], col.meta.width, col.meta.height);
  const r3 = makeResolver3D(col.world ? col.world[f] : null);
  return filterSelectedMetrics(computeMetricsBoth(r2, r3));
}

// Bloque .cellMetrics de una celda. Cada familia articular muestra 2D y 3D; las
// inclinaciones solo 2D. En filas de alumno (colB) agrega Δ2D y Δ3D vs el profe (colA)
// de la MISMA columna i, coloreado.
function cellMetricsEl(spec, i, f) {
  const col = spec.col;
  const mine = metricsFor(col, f);
  const isStudent = col === colB;
  const prof = (isStudent && colA.steps[i] != null) ? metricsFor(colA, colA.steps[i]) : null;
  const pBy = {};
  if (prof) prof.forEach((m) => (pBy[m.key] = m));
  const box = document.createElement("div");
  box.className = "cellMetrics";
  for (const m of mine) {
    const p = pBy[m.key];
    const part = (tag, mine_v, prof_v) => {
      let dHtml = "";
      if (isStudent && p) {
        const d = fmtDelta(prof_v, mine_v, m.unit);
        const th = m.unit === "%" ? 10 : 15;
        if (d) dHtml = ` <span class="md ${deltaClass(prof_v, mine_v, th)}">${d}</span>`;
      }
      return `<span class="mt">${tag}</span><span class="mv">${fmtMetric(mine_v, m.unit)}${dHtml}</span>`;
    };
    const row = document.createElement("div");
    row.className = "m";
    let html = `<span class="ml">${m.label}</span><span class="mvals">` + part("2D", m.v2d, p && p.v2d);
    if (!m.isTilt) html += part("3D", m.v3d, p && p.v3d);
    row.innerHTML = html + "</span>";
    box.appendChild(row);
  }
  return box;
}

// Pinta una celda según el mode: "skeleton" (encuadrado), "frame", o "both" (frame+esqueleto).
function cellPaint(canvas, col, f, mode) {
  const ctx = canvas.getContext("2d"), W = canvas.width, H = canvas.height;
  const La = colLm(col);
  const lm = La ? La[f] : null;
  const note = noteFor(col, mode, f);
  if (mode === "skeleton") {
    drawPose(ctx, lm, W, H);
    paintStrokes(ctx, note && note.drawing, W, H);
    return;
  }
  ctx.clearRect(0, 0, W, H);
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0, W, H);
    if (mode === "both") drawSkeletonFrame(ctx, lm, W, H);
    paintStrokes(ctx, note && note.drawing, W, H);
  };
  img.src = `/api/frame/${encodeURIComponent(col.video)}/${f}`;
}

// Modo de render del preview según el viewMode global (en "split" mostramos both).
function previewMode() { return viewMode === "split" ? "both" : viewMode; }

// Renderiza una celda a su propio canvas (async para los modos con video) — usado por
// el export para componer la infografía completa en una sola imagen.
function cellCanvasAsync(col, f, cellH, mode) {
  return new Promise((resolve) => {
    const cv = document.createElement("canvas");
    col.sizeCanvas(cv, cellH);
    const ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
    const La = colLm(col);
    const lm = La ? La[f] : null;
    const note = noteFor(col, mode, f);
    if (mode === "skeleton") {
      drawPose(ctx, lm, W, H);
      paintStrokes(ctx, note && note.drawing, W, H);
      resolve(cv); return;
    }
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, W, H);
      if (mode === "both") drawSkeletonFrame(ctx, lm, W, H);
      paintStrokes(ctx, note && note.drawing, W, H);
      resolve(cv);
    };
    img.onerror = () => { paintStrokes(ctx, note && note.drawing, W, H); resolve(cv); };
    img.src = `/api/frame/${encodeURIComponent(col.video)}/${f}`;
  });
}

const els = {
  nSteps: document.getElementById("nSteps"),
  viewMode: document.getElementById("viewMode"),
  autoBtn: document.getElementById("autoBtn"),
  saveBtn: document.getElementById("saveBtn"),
  exportBtn: document.getElementById("exportBtn"),
  status: document.getElementById("status"),
};

let selectedCol = -1;   // columna resaltada (comparar ese paso)

// ── Columna de un video (profe/alumno) ────────────────────────────────────────
function makeCol(rootId) {
  const root = document.getElementById(rootId);
  const $ = (s) => root.querySelector(s);
  const c = {
    rootId, root,
    video: null, lm: null, filled: null, corrections: {}, annotations: null,
    world: null, meta: null, clips: [], clip: null,
    steps: [], cursor: 0, notes: {},
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
    const La = colLm(c);
    const lm = La ? La[f] : null;
    const mode = previewMode();
    if (mode === "skeleton") { drawPose(pctx, lm, W, H); return; }
    const seq = ++pvSeq;               // descarta paints viejos al scrubbear
    pctx.clearRect(0, 0, W, H);
    const img = new Image();
    img.onload = () => {
      if (seq !== pvSeq) return;
      pctx.drawImage(img, 0, 0, W, H);
      if (mode === "both") drawSkeletonFrame(pctx, lm, W, H);
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
    c.lm = await loadLandmarks(video, {
      onWait: () => { els.status.textContent = "procesando pose…"; },
    });
    els.status.textContent = "";
    // correcciones manuales por video (hechas en /etiquetar o /compare) → anclas del relleno
    const ann = await (await fetch(`/api/annotations/${encodeURIComponent(video)}`)).json();
    ann.corrections = ann.corrections || {};
    c.annotations = ann;          // objeto completo (para persistir sin pisar angles/drawings)
    c.corrections = ann.corrections;
    c.filled = fillOcclusions(c.lm, c.corrections);
    try {
      c.world = await loadLandmarks(video, { world: true });
    } catch (e) { c.world = null; }
    c.clips = (await (await fetch(`/api/clips/${encodeURIComponent(video)}`)).json()).clips || [];
    const seq = await (await fetch(`/api/sequence/${encodeURIComponent(video)}`)).json();
    c.clip = null;
    populateClips();
    sizeCanvas(c.els.preview, PREVIEW_H);
    const [lo, hi] = bounds();
    c.els.slider.min = lo; c.els.slider.max = hi; c.cursor = lo;
    c.steps = (seq.steps && seq.steps.length) ? seq.steps.slice()
                                              : (autoSample(+els.nSteps.value), c.steps);
    c.notes = seq.notes || {};   // { frame: {comment, drawing:[strokes]} }
    drawPreview();
  }

  async function save() {
    if (!c.video) return false;
    try {
      const r = await fetch(`/api/sequence/${encodeURIComponent(c.video)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video: c.video, steps: c.steps, notes: c.notes }),
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

const colA = makeCol("colA");
const colB = makeCol("colB");

// Filas a mostrar según el modo: normal = 2 (profe/alumno); "split" = 4 (esqueleto y
// video en filas separadas por persona). Cada fila tiene su propio render mode.
function rowSpecs() {
  if (viewMode === "split") return [
    { label: "profe · esqueleto", col: colA, mode: "skeleton", rm: true },
    { label: "profe · video", col: colA, mode: "frame", rm: false },
    { label: "alumno · esqueleto", col: colB, mode: "skeleton", rm: true },
    { label: "alumno · video", col: colB, mode: "frame", rm: false },
  ];
  return [
    { label: "profe", col: colA, mode: viewMode, rm: true },
    { label: "alumno", col: colB, mode: viewMode, rm: true },
  ];
}

function makeCellEl(spec, i) {
  const col = spec.col;
  const cell = document.createElement("div");
  cell.className = "cell" + (i === selectedCol ? " sel" : "");
  cell.dataset.col = i;
  const f = col.steps[i];
  if (f === undefined) {           // hueco para mantener columnas alineadas
    cell.style.visibility = "hidden";
    cell.style.width = Math.round(CELL_H * (col.meta ? col.meta.width / col.meta.height : 0.5625)) + "px";
    return cell;
  }
  const no = document.createElement("span");
  no.className = "step-no"; no.textContent = i + 1;
  cell.appendChild(no);
  if (spec.rm) {                   // el × solo en la fila de esqueleto (evita duplicar)
    const rm = document.createElement("button");
    rm.className = "rm"; rm.textContent = "×"; rm.title = "quitar paso";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      col.steps.splice(i, 1);
      renderInfographic();
    });
    cell.appendChild(rm);
  }
  const cv = document.createElement("canvas");
  col.sizeCanvas(cv, CELL_H);
  cellPaint(cv, col, f, spec.mode);
  const cf = document.createElement("span");
  cf.className = "cf"; cf.textContent = `f ${f}`;
  cell.appendChild(cv); cell.appendChild(cf);
  // métricas solo en filas "primarias" (spec.rm) para no duplicar en modo split
  if (showMetrics && spec.rm) cell.appendChild(cellMetricsEl(spec, i, f));
  const note = noteFor(col, spec.mode, f);
  if (note && (note.comment || (note.drawing && note.drawing.length))) {
    const badge = document.createElement("span");
    badge.className = "badge"; badge.textContent = "✎";
    badge.title = note.comment || "tiene dibujo";
    cell.appendChild(badge);
  }
  cell.addEventListener("click", () => openModal(col, f, spec.mode));
  return cell;
}

function renderInfographic() {
  const infg = document.getElementById("infographic");
  infg.innerHTML = "";
  const ncols = Math.max(colA.steps.length, colB.steps.length);
  for (const spec of rowSpecs()) {
    const row = document.createElement("div");
    row.className = "seqRow";
    const lbl = document.createElement("div");
    lbl.className = "rowLabel"; lbl.textContent = spec.label;
    const cells = document.createElement("div");
    cells.className = "cells";
    for (let i = 0; i < ncols; i++) cells.appendChild(makeCellEl(spec, i));
    row.appendChild(lbl); row.appendChild(cells);
    infg.appendChild(row);
  }
}

// ── Controles globales ────────────────────────────────────────────────────────
els.viewMode.addEventListener("change", (e) => {
  viewMode = e.target.value;
  colA.drawPreview(); colB.drawPreview();
  renderInfographic();
});
document.getElementById("metricsToggle").addEventListener("change", (e) => {
  showMetrics = e.target.checked;
  renderInfographic();
});
initMetricsPicker(() => renderInfographic());
document.getElementById("fillToggle").addEventListener("change", (e) => {
  showFill = e.target.checked;
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

// Exporta la infografía completa (2 filas alineadas, etiquetas y nº de frame) a un PNG.
async function exportPNG() {
  const rows = rowSpecs();
  const ncols = Math.max(colA.steps.length, colB.steps.length);
  if (!ncols) return;
  els.status.textContent = "exportando…";

  const CELL = 220, PAD = 16, LBL = 90, GAP = 10, TITLE = 38, FNUM = 22;
  // alto extra para las métricas: 1 línea por métrica de inclinación, 2 (2D+3D) por articular
  const TWO_LINE = new Set(["knee", "hip", "elbow", "stack"]);
  const mLines = selectedMetricKeys().reduce((n, k) => n + (TWO_LINE.has(k) ? 2 : 1), 0);
  const MH = showMetrics ? Math.max(24, 10 + mLines * 11) : 0;
  const cw = (col) => Math.round(CELL * (col.meta ? col.meta.width / col.meta.height : 0.5625));
  const colW = Math.max(cw(colA), cw(colB));
  const rowH = CELL + FNUM + MH;
  const W = PAD + LBL + ncols * (colW + GAP) + PAD;
  const H = TITLE + rows.length * (rowH + GAP) + PAD;

  const big = document.createElement("canvas");
  big.width = W; big.height = H;
  const ctx = big.getContext("2d");
  ctx.fillStyle = "#faf9f6"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#1f2a33"; ctx.font = "bold 20px sans-serif";
  ctx.fillText(`Secuencia — ${colA.video}  vs  ${colB.video}`, PAD, 26);

  // pre-render de todas las celdas (async por los modos con video)
  const tasks = [];
  rows.forEach((r, ri) => r.col.steps.forEach((f, i) =>
    tasks.push(cellCanvasAsync(r.col, f, CELL, r.mode).then((cv) => ({ ri, i, f, cv })))));
  const cells = await Promise.all(tasks);

  const y0 = TITLE;
  rows.forEach((r, ri) => {
    ctx.fillStyle = "#33424e"; ctx.font = "bold 16px sans-serif";
    ctx.fillText(r.label, PAD, y0 + ri * (rowH + GAP) + CELL / 2);
  });
  for (const { ri, i, cv, f } of cells) {
    const colLeft = PAD + LBL + i * (colW + GAP);
    const cx = colLeft + (colW - cv.width) / 2;
    const y = y0 + ri * (rowH + GAP);
    ctx.fillStyle = "#11161d"; ctx.fillRect(cx, y, cv.width, CELL);
    ctx.drawImage(cv, cx, y);
    ctx.strokeStyle = "#d2cec2"; ctx.strokeRect(cx, y, cv.width, CELL);
    ctx.fillStyle = "#5b6b77"; ctx.font = "12px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`f ${f}`, cx + cv.width / 2, y + CELL + 15);
    ctx.textAlign = "left";
    // métricas bajo la celda (solo filas primarias); Δ vs profe en filas de alumno
    if (showMetrics && rows[ri].rm) {
      const col = rows[ri].col;
      const mine = metricsFor(col, f);
      const isStu = col === colB;
      const prof = (isStu && colA.steps[i] != null) ? metricsFor(colA, colA.steps[i]) : null;
      const pBy = {};
      if (prof) prof.forEach((m) => (pBy[m.key] = m));
      ctx.font = "10px sans-serif";
      let ty = y + CELL + FNUM;
      const drawLine = (label, tag, mineV, profV, unit) => {
        ctx.fillStyle = "#5b6b77";
        const line = `${label} ${tag}: ${fmtMetric(mineV, unit)}`;
        ctx.fillText(line, colLeft, ty);
        if (isStu && profV != null && mineV != null) {
          const d = fmtDelta(profV, mineV, unit);
          if (d) {
            const cls = deltaClass(profV, mineV, unit === "%" ? 10 : 15);
            ctx.fillStyle = cls === "dx-far" ? "#e76f51" : cls === "dx-near" ? "#2a9d8f" : "#8b99a4";
            ctx.fillText(" " + d, colLeft + ctx.measureText(line).width + 2, ty);
          }
        }
        ty += 11;
      };
      for (const m of mine) {
        const p = pBy[m.key];
        drawLine(m.label, "2D", m.v2d, p && p.v2d, m.unit);
        if (!m.isTilt) drawLine(m.label, "3D", m.v3d, p && p.v3d, m.unit);
      }
    }
  }

  const a = document.createElement("a");
  a.download = "secuencia.png";
  a.href = big.toDataURL("image/png");
  a.click();
  els.status.textContent = "exportado ✓";
  setTimeout(() => (els.status.textContent = ""), 2000);
}
els.exportBtn.addEventListener("click", exportPNG);

// ── Modal: vista previa de una escena (comentar + dibujar) ────────────────────
const modal = {
  el: document.getElementById("modal"),
  base: document.getElementById("mBase"),
  overlay: document.getElementById("mOverlay"),
  title: document.getElementById("mTitle"),
  comment: document.getElementById("mComment"),
  col: null, f: 0, strokes: [], tool: "draw", W: 0, H: 0,
};
const mbctx = modal.base.getContext("2d");
const moctx = modal.overlay.getContext("2d");
let mStroke = null;
let mArrowTmp = null; // flecha en arrastre {x1,y1,x2,y2} (px) o null
let mFixIdx = null;   // landmark en arrastre (modo corregir)

// Herramientas del modal que editan anotaciones (vs "fix" que mueve landmarks).
function mDrawLike(t) { return t === "draw" || t === "text" || t === "arrow"; }

// Dibuja el contenido dinámico del overlay según el modo del modal.
function drawModalDynamic() {
  const W = modal.overlay.width, H = modal.overlay.height;
  moctx.clearRect(0, 0, W, H);
  if (modal.tool === "fix") {
    const La = colLm(modal.col);
    drawSkeletonFrame(moctx, La ? La[modal.f] : null, W, H);
  } else {
    paintStrokes(moctx, modal.strokes, W, H);
    if (mArrowTmp)   // preview de la flecha en arrastre
      drawArrowShape(moctx, mArrowTmp.x1, mArrowTmp.y1, mArrowTmp.x2, mArrowTmp.y2,
                     ANNOT_COLOR, annotLineWidth(H) * 1.2);
  }
}
function drawModalStrokes() { drawModalDynamic(); }   // compat

// Dibuja la base del modal. En "fix" siempre el frame del video (para corregir sobre la
// imagen real); en "draw" la representación de la celda (esqueleto / video / ambos).
function renderModalBase() {
  const W = modal.W, H = modal.H, col = modal.col, f = modal.f, mode = modal.mode;
  const La = colLm(col);
  const lm = La ? La[f] : null;
  mbctx.clearRect(0, 0, W, H);
  if (mDrawLike(modal.tool) && mode === "skeleton") {
    drawPose(mbctx, lm, W, H);
  } else {
    const img = new Image();
    img.onload = () => {
      mbctx.drawImage(img, 0, 0, W, H);
      if (mDrawLike(modal.tool) && mode === "both") drawSkeletonFrame(mbctx, lm, W, H);
    };
    img.src = `/api/frame/${encodeURIComponent(col.video)}/${f}`;
  }
}

// Landmark más cercano a pos (px del canvas) según el array activo; o null.
function modalNearest(pos, maxDist = 18) {
  const La = colLm(modal.col);
  const lm = La ? La[modal.f] : null;
  if (!lm) return null;
  const W = modal.overlay.width, H = modal.overlay.height;
  let best = null, bd = maxDist;
  for (let i = 0; i < 33; i++) {
    const p = lm[i];
    if (!valid(p)) continue;
    const d = Math.hypot(p[0] * W - pos.x, p[1] * H - pos.y);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Cambia el modo del modal (dibujar / texto / flecha / corregir) y re-renderiza.
function setModalTool(t) {
  modal.tool = t;
  document.getElementById("mDraw").classList.toggle("active", t === "draw");
  document.getElementById("mText").classList.toggle("active", t === "text");
  document.getElementById("mArrow").classList.toggle("active", t === "arrow");
  document.getElementById("mFix").classList.toggle("active", t === "fix");
  modal.overlay.style.cursor = t === "fix" ? "move" : t === "text" ? "text" : "crosshair";
  renderModalBase();
  drawModalDynamic();
}

// Persiste las correcciones de un video en el store de annotations (sin pisar
// angles/drawings que escriben /etiquetar y /compare).
async function saveCorrections(col) {
  if (!col.annotations) return false;
  col.annotations.video = col.video;
  col.annotations.corrections = col.corrections;
  try {
    const r = await fetch(`/api/annotations/${encodeURIComponent(col.video)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(col.annotations),
    });
    return r.ok && (await r.json()).ok;
  } catch (e) { return false; }
}

// Abre el modal mostrando la MISMA representación de la celda clickeada (esqueleto o
// video) y editando el dibujo de ESA representación.
function openModal(col, f, mode) {
  if (!col.meta) return;
  modal.col = col; modal.f = f; modal.mode = mode;
  const note = noteFor(col, mode, f) || {};
  // copia profunda de los trazos para editar sin tocar lo guardado hasta "guardar"
  modal.strokes = note.drawing ? JSON.parse(JSON.stringify(note.drawing)) : [];
  modal.comment.value = note.comment || "";
  modal.title.textContent =
    `${col.video} — frame ${f} · ${repOf(mode) === "skeleton" ? "esqueleto" : "video"}`;
  const aspect = col.meta.width / col.meta.height;
  const H = Math.min(560, Math.round(window.innerHeight * 0.6));
  const W = Math.round(H * aspect);
  modal.W = W; modal.H = H;
  for (const cv of [modal.base, modal.overlay]) { cv.width = W; cv.height = H; }
  modal.base.parentElement.style.width = W + "px";
  modal.base.parentElement.style.height = H + "px";
  setModalTool("draw");   // base + overlay según el modo
  modal.el.classList.add("show");
}

function closeModal() { modal.el.classList.remove("show"); modal.col = null; }

function mPos(e) {
  const r = modal.overlay.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (modal.overlay.width / r.width),
    y: (e.clientY - r.top) * (modal.overlay.height / r.height),
  };
}

modal.overlay.addEventListener("mousedown", (e) => {
  if (modal.tool === "fix") { mFixIdx = modalNearest(mPos(e)); return; }
  const p = mPos(e);
  const W = modal.overlay.width, H = modal.overlay.height;
  if (modal.tool === "arrow") {
    mArrowTmp = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    return;
  }
  if (modal.tool === "text") {
    // input flotante sobre el stage del modal; Enter confirma
    const stage = modal.overlay.parentElement;   // .modalStage (position:relative)
    const r = stage.getBoundingClientRect();
    spawnTextInput(stage, e.clientX - r.left, e.clientY - r.top, (text) => {
      modal.strokes.push({ tool: "text", pos: [p.x / W, p.y / H], text, color: ANNOT_COLOR });
      drawModalStrokes();
    });
    return;
  }
  mStroke = { tool: "pen", stroke: [], color: ANNOT_COLOR };
  modal.strokes.push(mStroke);
  mStroke.stroke.push([p.x / W, p.y / H]);
});
modal.overlay.addEventListener("mousemove", (e) => {
  const W = modal.overlay.width, H = modal.overlay.height;
  if (modal.tool === "fix") {
    if (mFixIdx == null) return;
    const p = mPos(e), col = modal.col, f = modal.f;
    col.corrections[f] = col.corrections[f] || {};
    col.corrections[f][mFixIdx] = [p.x / W, p.y / H];
    col.filled = fillOcclusions(col.lm, col.corrections);   // re-rellenar: propaga a vecinos
    drawModalDynamic();
    return;
  }
  if (mArrowTmp) {
    const p = mPos(e);
    mArrowTmp.x2 = p.x; mArrowTmp.y2 = p.y;
    drawModalStrokes();
    return;
  }
  if (!mStroke) return;
  const p = mPos(e);
  mStroke.stroke.push([p.x / W, p.y / H]);
  drawModalStrokes();
});
window.addEventListener("mouseup", async () => {
  if (modal.tool === "fix" && mFixIdx != null) {
    mFixIdx = null;
    await saveCorrections(modal.col);
    renderInfographic();   // refrescar celdas con la corrección + propagación
  }
  if (mArrowTmp) {         // terminó una flecha → persistir si no es un click
    const W = modal.overlay.width, H = modal.overlay.height;
    if (Math.hypot(mArrowTmp.x2 - mArrowTmp.x1, mArrowTmp.y2 - mArrowTmp.y1) > 8) {
      modal.strokes.push({
        tool: "arrow",
        from: [mArrowTmp.x1 / W, mArrowTmp.y1 / H],
        to:   [mArrowTmp.x2 / W, mArrowTmp.y2 / H],
        color: ANNOT_COLOR,
      });
    }
    mArrowTmp = null;
    drawModalStrokes();
  }
  mStroke = null;
});

document.getElementById("mDraw").addEventListener("click", () => setModalTool("draw"));
document.getElementById("mText").addEventListener("click", () => setModalTool("text"));
document.getElementById("mArrow").addEventListener("click", () => setModalTool("arrow"));
document.getElementById("mFix").addEventListener("click", () => setModalTool("fix"));
document.getElementById("mUndo").addEventListener("click", () => {
  modal.strokes.pop(); drawModalStrokes();
});
document.getElementById("mClear").addEventListener("click", () => {
  modal.strokes = []; drawModalStrokes();
});
document.getElementById("mClose").addEventListener("click", closeModal);
modal.el.addEventListener("click", (e) => { if (e.target === modal.el) closeModal(); });

document.getElementById("mSave").addEventListener("click", async () => {
  const col = modal.col; if (!col) return;
  const comment = modal.comment.value.trim();
  const key = noteKey(modal.mode, modal.f);
  if (comment || modal.strokes.length) {
    col.notes[key] = { comment, drawing: modal.strokes };
  } else {
    delete col.notes[key];   // vacío: no guardar nota
  }
  const ok = await col.save();
  els.status.textContent = ok ? "guardado ✓" : "error";
  setTimeout(() => (els.status.textContent = ""), 2000);
  renderInfographic();           // refrescar el indicador ✎
  closeModal();
});

// ── Init ──────────────────────────────────────────────────────────────────────
function pick(videos, prefer, fallbackIdx) {
  const hit = videos.find((v) => v.toLowerCase().includes(prefer));
  return hit || videos[fallbackIdx] || videos[0] || null;
}

async function init() {
  const { videos } = await (await fetch("/api/videos")).json();
  const lib = await loadLibrary();
  for (const col of [colA, colB])
    populateVideoSelect(col.els.videoSelect, videos, lib);
  const vA = pickByRole(videos, lib, "profesor") || pick(videos, "profesor", 0);
  const vB = pickByRole(videos, lib, "alumno") || pick(videos, "estudiante", 1);
  if (vA) await colA.load(vA);
  if (vB) await colB.load(vB);
  renderInfographic();
}

init();
