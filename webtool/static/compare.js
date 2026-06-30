// compare.js — controlador de la vista de comparación de 2 videos.
// Instancia dos panes (createPane) y, con el toggle "sync" activo, espeja las
// acciones de navegación de un pane en el otro.

const paneA = createPane(document.getElementById("paneA"));
const paneB = createPane(document.getElementById("paneB"));
const syncToggle = document.getElementById("syncToggle");

// Espejo: cuando sync está activo, una acción en un pane se replica en el gemelo
// con propagate=false (para no rebotar de vuelta).
function mirror(src, action) {
  if (!syncToggle.checked) return;
  const dst = src === paneA ? paneB : paneA;
  const fn = dst[action.fn];
  if (typeof fn === "function") fn(...action.args, false);
}
paneA.onAction = (action) => mirror(paneA, action);
paneB.onAction = (action) => mirror(paneB, action);

// ── Métricas: barra Δ que compara el frame actual de A vs el de B, en vivo ─────
const metricsToggle = document.getElementById("metricsToggle");
const deltaBar = document.getElementById("deltaBar");

// Una fila de método (2D o 3D): tag, valor A, valor B, Δ coloreado.
function methodRow(tag, av, bv) {
  const d = fmtDelta(av, bv) || "—";
  return `<span class="drow"><span class="mtag">${tag}</span>` +
    `<span class="a">${fmtMetric(av)}</span><span class="b">${fmtMetric(bv)}</span>` +
    `<span class="d ${deltaClass(av, bv)}">${d}</span></span>`;
}

function updateDeltaBar() {
  const A = paneA.metrics || [], B = paneB.metrics || [];
  const byKeyB = {};
  B.forEach((m) => (byKeyB[m.key] = m));
  deltaBar.innerHTML = "";
  if (!A.length && !B.length) return;
  const hint = document.createElement("span");
  hint.className = "dhint";
  hint.textContent = "A profe · B alumno · Δ = B − A";
  deltaBar.appendChild(hint);
  for (const a of A) {
    const b = byKeyB[a.key] || {};
    const card = document.createElement("div");
    card.className = "dcard";
    let html = `<span class="dlabel">${a.label}</span>`;
    html += methodRow("2D", a.v2d, b.v2d);
    if (!a.isTilt) html += methodRow("3D", a.v3d, b.v3d);
    card.innerHTML = html;
    deltaBar.appendChild(card);
  }
}
paneA.onMetrics = updateDeltaBar;
paneB.onMetrics = updateDeltaBar;

function applyMetricsVisibility() {
  document.body.classList.toggle("metrics-off", !metricsToggle.checked);
}
metricsToggle.addEventListener("change", applyMetricsVisibility);
applyMetricsVisibility();

// Defaults: profe a la izquierda, alumno a la derecha (si están disponibles).
function pick(videos, prefer, fallbackIdx) {
  const hit = videos.find((v) => v.toLowerCase().includes(prefer));
  return hit || videos[fallbackIdx] || videos[0] || null;
}

async function init() {
  // ambos panes leen la misma lista; poblar selects una vez por pane
  const videos = await paneA.loadVideos();
  await paneB.loadVideos();

  const vA = pick(videos, "profesor", 0);
  const vB = pick(videos, "estudiante", 1);
  if (vA) await paneA.load(vA);
  if (vB) await paneB.load(vB);
}

init();
