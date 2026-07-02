// Helper compartido para cargar landmarks con polling.
// El backend extrae la pose (MediaPipe) en background: si el .npy aún no existe,
// /api/landmarks|worldlandmarks responde 202 {status:"processing"}. Este helper
// reintenta hasta que llega el 200 con los datos, o lanza si el server da 500.
// Global (sin módulos): incluir <script src="/static/api.js"> antes de los controllers.

const _POLL_MS = 800; // espera entre reintentos mientras extrae (la extracción son minutos)

// Carga los landmarks de un video, esperando a la extracción en background si hace falta.
//   video   nombre del archivo de video
//   world   true -> world 3D (/api/worldlandmarks), false -> 2D (/api/landmarks)
//   smooth  true -> Savitzky-Golay al servir (solo world; anti-wobble del viewer 3D)
//   onWait  callback(intentos) que se llama en cada reintento (para pintar estado)
// Devuelve el array `landmarks`. Lanza Error con mensaje legible si el server falla.
async function loadLandmarks(video, { world = false, smooth = false, onWait } = {}) {
  const endpoint = world ? "worldlandmarks" : "landmarks";
  const url = `/api/${endpoint}/${encodeURIComponent(video)}` + (smooth ? "?smooth=1" : "");
  let attempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await fetch(url);
    if (r.status === 202) {
      attempts += 1;
      if (typeof onWait === "function") onWait(attempts);
      await new Promise((res) => setTimeout(res, _POLL_MS));
      continue;
    }
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try {
        const j = await r.json();
        if (j && j.error) msg = j.error;
      } catch (_) { /* respuesta no-JSON */ }
      throw new Error("extracción de pose falló: " + msg);
    }
    return (await r.json()).landmarks;
  }
}

// ── Librería de videos (tags por maniobra / persona / rol) ────────────────────
// library.json: { videos: { "<nombre>": {maniobra, persona, rol} }, maniobras: [...] }

async function loadLibrary() {
  try {
    const r = await fetch("/api/library");
    if (r.ok) return await r.json();
  } catch (_) { /* sin librería → sin tags */ }
  return { videos: {}, maniobras: [] };
}

async function saveLibrary(lib) {
  const r = await fetch("/api/library", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(lib),
  });
  return r.ok && (await r.json()).ok;
}

// Puebla un <select> de videos agrupado por maniobra (<optgroup>), con sufijo
// "· persona (rol)". Videos sin tag van al grupo "sin clasificar" al final.
function populateVideoSelect(sel, videos, lib) {
  const tagOf = (v) => (lib && lib.videos && lib.videos[v]) || {};
  sel.innerHTML = "";
  const groups = new Map();
  for (const v of videos) {
    const m = tagOf(v).maniobra || "sin clasificar";
    if (!groups.has(m)) groups.set(m, []);
    groups.get(m).push(v);
  }
  const names = [...groups.keys()].sort((a, b) =>
    (a === "sin clasificar") - (b === "sin clasificar") || a.localeCompare(b));
  for (const m of names) {
    const og = document.createElement("optgroup");
    og.label = m;
    for (const v of groups.get(m)) {
      const o = document.createElement("option");
      o.value = v;
      const t = tagOf(v);
      o.textContent = v + (t.persona ? ` · ${t.persona}` : "") + (t.rol ? ` (${t.rol})` : "");
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
}

// Primer video con rol `rol` en la librería, o null (para defaults de /compare).
function pickByRole(videos, lib, rol) {
  if (!lib || !lib.videos) return null;
  return videos.find((v) => (lib.videos[v] || {}).rol === rol) || null;
}
