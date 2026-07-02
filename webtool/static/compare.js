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

// Una fila de método (2D o 3D): tag, valor A, valor B, Δ coloreado. `unit` para métricas
// en % (peso) vs grados; el umbral de color se afloja para el peso (puntos %).
function methodRow(tag, av, bv, unit = "°") {
  const d = fmtDelta(av, bv, unit) || "—";
  const thresh = unit === "%" ? 10 : 15;
  return `<span class="drow"><span class="mtag">${tag}</span>` +
    `<span class="a">${fmtMetric(av, unit)}</span><span class="b">${fmtMetric(bv, unit)}</span>` +
    `<span class="d ${deltaClass(av, bv, thresh)}">${d}</span></span>`;
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
    html += methodRow("2D", a.v2d, b.v2d, a.unit);
    if (!a.isTilt) html += methodRow("3D", a.v3d, b.v3d, a.unit);
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

// Picker de métricas visibles: re-renderiza paneles (la delta bar sigue vía onMetrics).
initMetricsPicker(() => {
  paneA.refreshMetrics();
  paneB.refreshMetrics();
});

// Toggle de relleno de oclusiones (afecta ambos paneles).
const fillToggle = document.getElementById("fillToggle");
fillToggle.addEventListener("change", () => {
  paneA.setFill(fillToggle.checked);
  paneB.setFill(fillToggle.checked);
});

// Toggle de centro de masa + balance (afecta ambos paneles).
const balanceToggle = document.getElementById("balanceToggle");
balanceToggle.addEventListener("change", () => {
  paneA.setBalance(balanceToggle.checked);
  paneB.setBalance(balanceToggle.checked);
});

// Defaults: profe a la izquierda, alumno a la derecha. Primero por rol de la
// librería; fallback: match por nombre de archivo.
function pick(videos, prefer, fallbackIdx) {
  const hit = videos.find((v) => v.toLowerCase().includes(prefer));
  return hit || videos[fallbackIdx] || videos[0] || null;
}

async function init() {
  // ambos panes leen la misma lista; poblar selects una vez por pane
  const lib = await loadLibrary();
  const videos = await paneA.loadVideos(lib);
  await paneB.loadVideos(lib);

  // Deep link ?b= (video del alumno desde el dashboard): pane A elige la
  // referencia de profesor de la misma maniobra. Sin param, defaults por rol.
  const bParam = qs("b");
  const vB = (bParam && videos.includes(bParam)) ? bParam
    : pickByRole(videos, lib, "alumno") || pick(videos, "estudiante", 1);
  const vA = (bParam && pickReference(videos, lib, vB))
    || pickByRole(videos, lib, "profesor") || pick(videos, "profesor", 0);
  if (vA) await paneA.load(vA);
  if (vB) await paneB.load(vB);
}

init();
