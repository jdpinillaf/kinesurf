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
  return out;
}

function fmtMetric(v) { return v == null ? "—" : Math.round(v) + "°"; }

// Δ con signo (b − a). Se calcula sobre los valores YA redondeados para que los
// números mostrados siempre cuadren (a, b y Δ coherentes). "" si falta algún valor.
function fmtDelta(a, b) {
  if (a == null || b == null) return "";
  const d = Math.round(b) - Math.round(a);
  return (d > 0 ? "+" : "") + d + "°";
}

// Clase de color según la magnitud de la diferencia (umbral simple).
function deltaClass(a, b, thresh = 15) {
  if (a == null || b == null) return "dx-na";
  return Math.abs(b - a) > thresh ? "dx-far" : "dx-near";
}

// ── Centro de masa + balance (lectura clave de un coach) ──────────────────────
// ptOf(idx) -> {x,y} en PÍXELES del canvas (p.ej. getPoint del pane). Devuelve la
// geometría de balance, o null si no hay tronco.
function midPx(ptOf, i, j) {
  const a = ptOf(i), b = ptOf(j);
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function balanceGeom(ptOf) {
  const sh = midPx(ptOf, 11, 12), hip = midPx(ptOf, 23, 24);
  if (!sh || !hip) return null;
  // CoM proxy de tronco (estable): pesa más la cadera. No es modelo segmentario completo.
  const com = { x: 0.6 * hip.x + 0.4 * sh.x, y: 0.6 * hip.y + 0.4 * sh.y };
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
