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

// Ángulo en b (grados) entre los vectores b→a y b→c. null si falta algún punto.
function angleAt(a, b, c) {
  if (!a || !b || !c) return null;
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const den = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) + 1e-9;
  const cos = (v1.x * v2.x + v1.y * v2.y) / den;
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

// Construye un resolver getPt(idx) -> {x, y, vis}|null desde un frame de landmarks
// normalizados, escalando a píxeles (W,H) y aplicando gating por visibilidad.
function makeResolver(lmFrame, W, H, minVis = 0.5) {
  return (idx) => {
    const p = lmFrame ? lmFrame[idx] : null;
    if (!p || p[0] == null || p[1] == null) return null;
    if (p[3] != null && p[3] < minVis) return null;
    return { x: p[0] * W, y: p[1] * H, vis: p[3] == null ? 1 : p[3] };
  };
}

// Calcula todas las métricas dado un resolver getPt(idx) -> {x, y, vis}|null.
// Devuelve un array ordenado [{key, label, value|null}] (value en grados).
function computeMetrics(getPt) {
  const out = [];
  for (const fam of ANGLE_FAMILIES) {
    let best = null, bestVis = -1;
    for (const [a, b, c] of fam.sides) {
      const pa = getPt(a), pb = getPt(b), pc = getPt(c);
      if (!pa || !pb || !pc) continue;
      const vis = Math.min(pa.vis, pb.vis, pc.vis);
      if (vis > bestVis) { bestVis = vis; best = angleAt(pa, pb, pc); }
    }
    out.push({ key: fam.key, label: fam.label, value: best });
  }
  for (const t of TILT_FAMILIES) {
    out.push({ key: t.key, label: t.label, value: lineTilt(getPt(t.line[0]), getPt(t.line[1])) });
  }
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
