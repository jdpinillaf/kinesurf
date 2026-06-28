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
