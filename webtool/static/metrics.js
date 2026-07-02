// metrics.js — métricas biomecánicas client-side desde landmarks de MediaPipe.
// Funciones puras (sin DOM). Compartido por /compare (pane.js) y /sequence (sequence.js).
//
// Las métricas son DERIVADAS de los landmarks ya cargados en el navegador → no se
// persisten; se recalculan siempre. Se calculan en PÍXELES (norm·W, norm·H) para que la
// proporción del video no distorsione los ángulos. Gating por visibility (canal 4).
//
// Familias: por cada ángulo articular hay un lado izq y der; se elige automáticamente el
// lado más visible (resuelve la oclusión en plano lateral y evita "—" de más).
// Índices (pose.py): hombros 11/12, codos 13/14, muñecas 15/16, caderas 23/24,
// rodillas 25/26, tobillos 27/28.

// Ángulo en b (grados) entre los vectores b→a y b→c. Usa z cuando los puntos lo traen
// (resolver 3D world) → ángulo 3D; sin z (resolver 2D) → z=0 → ángulo 2D. null si falta.
function angleAt(a, b, c) {
  if (!a || !b || !c) return null;
  const az = a.z || 0, bz = b.z || 0, cz = c.z || 0;
  const v1 = { x: a.x - b.x, y: a.y - b.y, z: az - bz };
  const v2 = { x: c.x - b.x, y: c.y - b.y, z: cz - bz };
  const den = Math.hypot(v1.x, v1.y, v1.z) * Math.hypot(v2.x, v2.y, v2.z) + 1e-9;
  const cos = (v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / den;
  return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
}

// Inclinación de la línea p→q respecto a la horizontal, normalizada a [-90, 90] grados
// (signo: + si q queda por debajo de p en pantalla). null si falta algún punto.
function lineTilt(p, q) {
  if (!p || !q) return null;
  let t = Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI;
  if (t > 90) t -= 180;
  if (t < -90) t += 180;
  return t;
}

// Familias de ángulo articular: cada una con su lado izquierdo y derecho [a,b,c].
const ANGLE_FAMILIES = [
  { key: "knee",  label: "Rodilla", sides: [[23, 25, 27], [24, 26, 28]] },
  { key: "hip",   label: "Cadera",  sides: [[11, 23, 25], [12, 24, 26]] },
  { key: "elbow", label: "Codo",    sides: [[11, 13, 15], [12, 14, 16]] },
];
// Inclinaciones de línea (un solo cálculo, vs horizontal).
const TILT_FAMILIES = [
  { key: "sh_tilt",  label: "Inclin. hombros", line: [11, 12] },
  { key: "hip_tilt", label: "Inclin. caderas", line: [23, 24] },
];

// Resolver 2D: getPt(idx) -> {x, y, vis}|null desde landmarks normalizados, escalando a
// píxeles (W,H) y aplicando gating por visibilidad. (sin z → angleAt da ángulo 2D)
function makeResolver(lmFrame, W, H, minVis = 0.5) {
  return (idx) => {
    const p = lmFrame ? lmFrame[idx] : null;
    if (!p || p[0] == null || p[1] == null) return null;
    if (p[3] != null && p[3] < minVis) return null;
    return { x: p[0] * W, y: p[1] * H, vis: p[3] == null ? 1 : p[3] };
  };
}

// Resolver 3D: getPt(idx) -> {x, y, z, vis}|null desde world landmarks (metros, origen en
// cadera). El ángulo es invariante a escala → no hace falta normalizar.
function makeResolver3D(worldFrame, minVis = 0.5) {
  return (idx) => {
    const p = worldFrame ? worldFrame[idx] : null;
    if (!p || p[0] == null || p[1] == null || p[2] == null) return null;
    if (p[3] != null && p[3] < minVis) return null;
    return { x: p[0], y: p[1], z: p[2], vis: p[3] == null ? 1 : p[3] };
  };
}

// Ángulo de una familia articular eligiendo el lado (izq/der) MÁS visible. null si ninguno.
function familyBestAngle(fam, getPt) {
  let best = null, bestVis = -1;
  for (const [a, b, c] of fam.sides) {
    const pa = getPt(a), pb = getPt(b), pc = getPt(c);
    if (!pa || !pb || !pc) continue;
    const vis = Math.min(pa.vis, pb.vis, pc.vis);
    if (vis > bestVis) { bestVis = vis; best = angleAt(pa, pb, pc); }
  }
  return best;
}

// Calcula todas las métricas (solo 2D) — array [{key, label, value|null}].
function computeMetrics(getPt) {
  const out = [];
  for (const fam of ANGLE_FAMILIES)
    out.push({ key: fam.key, label: fam.label, value: familyBestAngle(fam, getPt) });
  for (const t of TILT_FAMILIES)
    out.push({ key: t.key, label: t.label, value: lineTilt(getPt(t.line[0]), getPt(t.line[1])) });
  return out;
}

// Punto medio de dos landmarks resueltos (para "landmarks virtuales": centro de hombros,
// caderas, tobillos). Devuelve {x,y,z,vis} o null si falta alguno.
function midOf(getPt, i, j) {
  const a = getPt(i), b = getPt(j);
  if (!a || !b) return null;
  return {
    x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2,
    vis: Math.min(a.vis == null ? 1 : a.vis, b.vis == null ? 1 : b.vis),
  };
}

// X-factor (rotación hombros-caderas, plano imagen): separación entre la inclinación de la
// línea de hombros y la de caderas. Proxy del coil/uncoil. null si falta.
function xFactor(getPt) {
  const s = lineTilt(getPt(11), getPt(12)), h = lineTilt(getPt(23), getPt(24));
  return (s == null || h == null) ? null : s - h;
}

// Apilado: ángulo hombros-medio → caderas-medio → tobillos-medio. 180° = línea recta
// (cuerpo apilado); menos = quebrado en la cadera. null si falta.
function stackAngle(getPt) {
  return angleAt(midOf(getPt, 11, 12), midOf(getPt, 23, 24), midOf(getPt, 27, 28));
}

// Calcula métricas en 2D y 3D a la vez → [{key, label, isTilt, v2d, v3d}].
// Familias articulares: v2d (imagen) y v3d (world). Inclinaciones: solo v2d (los world
// landmarks no están alineados a gravedad → "vs horizontal" no aplica en 3D).
function computeMetricsBoth(getPt2D, getPt3D) {
  const out = [];
  for (const fam of ANGLE_FAMILIES) {
    out.push({
      key: fam.key, label: fam.label, isTilt: false,
      v2d: familyBestAngle(fam, getPt2D),
      v3d: getPt3D ? familyBestAngle(fam, getPt3D) : null,
    });
  }
  for (const t of TILT_FAMILIES) {
    out.push({
      key: t.key, label: t.label, isTilt: true,
      v2d: lineTilt(getPt2D(t.line[0]), getPt2D(t.line[1])), v3d: null,
    });
  }
  // relaciones de coach
  out.push({ key: "xfactor", label: "Rotación", isTilt: true,
             v2d: xFactor(getPt2D), v3d: null });
  out.push({ key: "stack", label: "Apilado", isTilt: false,
             v2d: stackAngle(getPt2D), v3d: getPt3D ? stackAngle(getPt3D) : null });
  // distribución de peso (estimada): % sobre el pie delantero (eje tabla) + lateral aprox.
  const wd = weightDistribution(getPt2D, getPt3D);
  out.push({ key: "weight", label: "Peso ~del", isTilt: true, unit: "%",
             v2d: wd.valid ? wd.frontPct * 100 : null, v3d: null });
  if (wd.valid && wd.lateralPct != null)
    out.push({ key: "weight_lat", label: "Peso lat ~", isTilt: true, unit: "%",
               v2d: wd.lateralPct * 100, v3d: null });
  return out;
}

function fmtMetric(v, unit = "°") { return v == null ? "—" : Math.round(v) + unit; }

// Δ con signo (b − a). Se calcula sobre los valores YA redondeados para que los
// números mostrados siempre cuadren (a, b y Δ coherentes). "" si falta algún valor.
function fmtDelta(a, b, unit = "°") {
  if (a == null || b == null) return "";
  const d = Math.round(b) - Math.round(a);
  return (d > 0 ? "+" : "") + d + unit;
}

// Clase de color según la magnitud de la diferencia (umbral simple).
function deltaClass(a, b, thresh = 15) {
  if (a == null || b == null) return "dx-na";
  return Math.abs(b - a) > thresh ? "dx-far" : "dx-near";
}

// ── Selección de métricas visibles (picker "métricas ▾") ──────────────────────
// El profesor elige qué métricas ver según la maniobra (p. ej. en carving importa
// la inclinación de hombros; en pop-up el peso y la rodilla). Selección compartida
// por las vistas y persistida en localStorage.
const METRIC_CATALOG = [
  { key: "weight",     label: "Peso ~del" },
  { key: "weight_lat", label: "Peso lat ~" },
  { key: "knee",       label: "Rodilla" },
  { key: "hip",        label: "Cadera" },
  { key: "elbow",      label: "Codo" },
  { key: "sh_tilt",    label: "Inclin. hombros" },
  { key: "hip_tilt",   label: "Inclin. caderas" },
  { key: "xfactor",    label: "Rotación" },
  { key: "stack",      label: "Apilado" },
];
const DEFAULT_METRIC_KEYS = ["weight", "knee", "stack"];
const METRIC_SEL_LS = "surfMetricSelection";

function selectedMetricKeys() {
  try {
    const raw = JSON.parse(localStorage.getItem(METRIC_SEL_LS));
    if (Array.isArray(raw))
      return raw.filter((k) => METRIC_CATALOG.some((m) => m.key === k));
  } catch (e) { /* selección corrupta → defaults */ }
  return DEFAULT_METRIC_KEYS.slice();
}

function filterSelectedMetrics(list) {
  const sel = new Set(selectedMetricKeys());
  return list.filter((m) => sel.has(m.key));
}

// Monta las checkboxes dentro de <details id="metricsPick"> (si la vista lo tiene).
function initMetricsPicker(onChange) {
  const host = document.getElementById("metricsPick");
  if (!host) return;
  const listEl = host.querySelector(".mpickList");
  const sel = new Set(selectedMetricKeys());
  listEl.innerHTML = "";
  for (const m of METRIC_CATALOG) {
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = sel.has(m.key);
    cb.addEventListener("change", () => {
      if (cb.checked) sel.add(m.key); else sel.delete(m.key);
      const keys = METRIC_CATALOG.map((x) => x.key).filter((k) => sel.has(k));
      localStorage.setItem(METRIC_SEL_LS, JSON.stringify(keys));
      if (onChange) onChange();
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(" " + m.label));
    listEl.appendChild(lab);
  }
}

// ── Distribución de peso + centro de masa (lectura clave de un coach) ─────────
// El peso NO se mide (pose monocular no da fuerza real); se ESTIMA por la posición del
// centro de masa (CoM) sobre la base de sustentación (los pies). Proxy, no dinamómetro.
//
// Tuning (ajustar con videos reales):
const SEG_MIN_ANKLE_SEP_PX = 25;   // sep. horizontal mín. de tobillos para % fiable
const WEIGHT_BAR_MAX_PX = 90;      // altura de barra al 100% de carga
const WEIGHT_DELTA_THRESH = 10;    // Δ de peso (puntos %) que se pinta "lejos"

// Masas segmentarias (fracción del peso corporal) y ubicación del CoM del segmento
// (fracción proximal→distal), tabla de Winter/Dempster. El tronco se calcula aparte
// (usa puntos medios de hombros/caderas). [proxIdx, distIdx, comFrac, mass].
const LIMB_SEGMENTS = [
  [0, 0, 0, 0.081],        // cabeza+cuello → punto en la nariz
  [15, 15, 0, 0.006], [16, 16, 0, 0.006],       // manos → en la muñeca
  [11, 13, 0.436, 0.028], [12, 14, 0.436, 0.028], // brazo superior
  [13, 15, 0.430, 0.016], [14, 16, 0.430, 0.016], // antebrazo
  [23, 25, 0.433, 0.100], [24, 26, 0.433, 0.100], // muslo
  [25, 27, 0.433, 0.0465], [26, 28, 0.433, 0.0465], // pierna
  [27, 31, 0.5, 0.0145], [28, 32, 0.5, 0.0145],   // pie (tobillo→foot_index; fallback tobillo)
];

// Punto del CoM de un segmento; si falta el distal, cae al proximal (p.ej. pie sin
// foot_index visible → tobillo). null si falta el proximal.
function segCoMPoint(ptOf, pi, di, frac) {
  const p = ptOf(pi);
  if (!p) return null;
  if (di === pi) return { x: p.x, y: p.y, z: p.z || 0 };
  const d = ptOf(di);
  if (!d) return { x: p.x, y: p.y, z: p.z || 0 };
  return {
    x: p.x + frac * (d.x - p.x), y: p.y + frac * (d.y - p.y),
    z: (p.z || 0) + frac * ((d.z || 0) - (p.z || 0)),
  };
}

// CoM de cuerpo completo por modelo segmentario. Normaliza sobre la masa de los segmentos
// realmente visibles (robusto a oclusión). ptOf(idx) -> {x,y[,z]} (px 2D o metros world).
// Devuelve {x,y,z} o null si no hay ningún segmento.
function segmentalCoM(ptOf) {
  let mx = 0, my = 0, mz = 0, M = 0;
  const add = (pt, mass) => {
    if (pt) { mx += mass * pt.x; my += mass * pt.y; mz += mass * (pt.z || 0); M += mass; }
  };
  // tronco (masa dominante): mid-hombros → mid-caderas, CoM al 50%.
  const shL = ptOf(11), shR = ptOf(12), hL = ptOf(23), hR = ptOf(24);
  if (shL && shR && hL && hR) {
    const sh = { x: (shL.x + shR.x) / 2, y: (shL.y + shR.y) / 2, z: ((shL.z || 0) + (shR.z || 0)) / 2 };
    const hip = { x: (hL.x + hR.x) / 2, y: (hL.y + hR.y) / 2, z: ((hL.z || 0) + (hR.z || 0)) / 2 };
    add({ x: (sh.x + hip.x) / 2, y: (sh.y + hip.y) / 2, z: (sh.z + hip.z) / 2 }, 0.497);
  }
  for (const [pi, di, frac, mass] of LIMB_SEGMENTS) add(segCoMPoint(ptOf, pi, di, frac), mass);
  if (M < 1e-6) return null;
  return { x: mx / M, y: my / M, z: mz / M };
}

// Distribución de peso: front/back (2D, eje largo de la tabla) por proyección del CoM sobre
// el segmento entre tobillos; lateral (3D world, aproximado) por offset perpendicular en el
// plano de suelo. Devuelve {valid, frontPct, backPct, frontSide, front, back, com,
// lateralPct, lateralSide}. front/back en [0,1]; lateralPct en [-1,1] (+toe/−heel).
function weightDistribution(getPt2D, getPt3D) {
  const com = segmentalCoM(getPt2D);
  const aL = getPt2D(27), aR = getPt2D(28);
  if (!com || !aL || !aR) return { valid: false };
  if (Math.abs(aR.x - aL.x) < SEG_MIN_ANKLE_SEP_PX) return { valid: false }; // pies casi alineados
  // pie delantero = tobillo hacia donde mira el surfista (nariz vs cadera media).
  const nose = getPt2D(0), hL = getPt2D(23), hR = getPt2D(24);
  const hipMidX = (hL && hR) ? (hL.x + hR.x) / 2 : (aL.x + aR.x) / 2;
  const facing = nose ? Math.sign(nose.x - hipMidX) : 0;
  let front, back, frontSide;
  const rightIsFront = facing >= 0 ? aR.x >= aL.x : aL.x > aR.x;
  if (rightIsFront) { front = aR; back = aL; frontSide = "der"; }
  else { front = aL; back = aR; frontSide = "izq"; }
  let frontPct = (com.x - back.x) / (front.x - back.x);
  frontPct = Math.max(0, Math.min(1, frontPct));
  // lateral (aprox) con world 3D: plano suelo (x,z), offset perpendicular a la línea de pies.
  let lateralPct = null, lateralSide = null;
  if (getPt3D) {
    const c3 = segmentalCoM(getPt3D), l3 = getPt3D(27), r3 = getPt3D(28);
    if (c3 && l3 && r3) {
      const ax = r3.x - l3.x, az = (r3.z || 0) - (l3.z || 0);
      const len = Math.hypot(ax, az) || 1e-6;
      const dx = c3.x - (l3.x + r3.x) / 2, dz = (c3.z || 0) - ((l3.z || 0) + (r3.z || 0)) / 2;
      const perp = (dx * az - dz * ax) / len;      // metros, signo = lado
      lateralPct = Math.max(-1, Math.min(1, perp / (len * 0.5)));
      lateralSide = perp >= 0 ? "toe" : "heel";
    }
  }
  return { valid: true, frontPct, backPct: 1 - frontPct, frontSide, front, back, com, lateralPct, lateralSide };
}

// Barra vertical de carga sobre cada pie (altura ∝ % de peso). ptOf en px. No dibuja si
// la distribución no es fiable (pies alineados / faltan puntos).
function drawWeightBars(ctx, ptOf) {
  const w = weightDistribution(ptOf, null);
  if (!w.valid) return;
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "bold 12px system-ui, sans-serif";
  const bar = (ankle, pct, isFront) => {
    if (!ankle) return;
    const h = Math.max(2, pct * WEIGHT_BAR_MAX_PX), bw = 14, x = ankle.x, yb = ankle.y;
    ctx.fillStyle = isFront ? "rgba(52,211,153,.85)" : "rgba(232,121,249,.78)";
    ctx.fillRect(x - bw / 2, yb - h, bw, h);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.strokeRect(x - bw / 2, yb - h, bw, h);
    ctx.fillStyle = "#fff";
    ctx.fillText(Math.round(pct * 100) + "%", x, yb - h - 4);
  };
  bar(w.front, w.frontPct, true);
  bar(w.back, w.backPct, false);
  ctx.restore();
}

// ── Balance: CoM + plomada + base (reusa el CoM segmentario) ──────────────────
// ptOf(idx) -> {x,y} en PÍXELES del canvas. Devuelve geometría de balance o null.
function balanceGeom(ptOf) {
  const com = segmentalCoM(ptOf);
  if (!com) return null;
  const aL = ptOf(27), aR = ptOf(28);
  let base = null, ankleY = null, inside = true;
  if (aL && aR) {
    base = [aL, aR];
    ankleY = (aL.y + aR.y) / 2;
    const lo = Math.min(aL.x, aR.x), hi = Math.max(aL.x, aR.x);
    const m = Math.max(8, (hi - lo) * 0.15);   // margen tolerable de la base
    inside = com.x >= lo - m && com.x <= hi + m;
  }
  return { com, base, ankleY, inside };
}
// Dibuja CoM (magenta) + plomada vertical + base entre tobillos. Verde si la plomada cae
// sobre la base de sustentación, rojo si el peso se va atrás/adelante.
function drawBalance(ctx, ptOf) {
  const g = balanceGeom(ptOf);
  if (!g) return;
  const col = g.inside ? "#34d399" : "#f87171";
  ctx.save();
  if (g.base) {
    ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(g.base[0].x, g.base[0].y); ctx.lineTo(g.base[1].x, g.base[1].y); ctx.stroke();
  }
  const yEnd = g.ankleY != null ? g.ankleY : g.com.y + 60;
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
  ctx.beginPath(); ctx.moveTo(g.com.x, g.com.y); ctx.lineTo(g.com.x, yEnd); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#e879f9";
  ctx.beginPath(); ctx.arc(g.com.x, g.com.y, 6, 0, 2 * Math.PI); ctx.fill();
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.restore();
}
