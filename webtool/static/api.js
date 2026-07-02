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
  videos = studentFilter(videos, lib);  // con ?student=, solo sus videos + referencias
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

// ── Dashboard de coach (estudiantes) ──────────────────────────────────────────
// Helpers aditivos: NO tocar lo de arriba (compartido con el workstream de análisis).

// Query param de la URL actual, o null.
function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

async function apiGet(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  return r.json();
}

async function apiSend(url, method, body) {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  return r.json();
}

// Lista de estudiantes con resumen (dispara la migración lazy en el server).
async function loadStudents() {
  return (await apiGet("/api/students")).students;
}

// Deep link a una vista con contexto de estudiante.
//   viewUrl("/sequence", "video.mov", "s-ana") -> "/sequence?video=video.mov&student=s-ana"
//   La vista /compare usa el param "b" (pane alumno) en vez de "video".
function viewUrl(base, video, studentId) {
  const p = new URLSearchParams();
  p.set(base === "/compare" ? "b" : "video", video);
  if (studentId) p.set("student", studentId);
  return `${base}?${p}`;
}

// Video de referencia (rol=profesor) para comparar contra `video`: prefiere la
// misma maniobra; si no hay, cualquier referencia de profesor.
function pickReference(videos, lib, video) {
  if (!lib || !lib.videos) return null;
  const tagOf = (v) => lib.videos[v] || {};
  const maniobra = tagOf(video).maniobra;
  return videos.find((v) => tagOf(v).rol === "profesor" &&
                            maniobra && tagOf(v).maniobra === maniobra) ||
         videos.find((v) => tagOf(v).rol === "profesor") || null;
}

// ── Contexto de estudiante en las vistas de análisis (?student=<id>) ─────────
// api.js se incluye en todas las vistas: chip "← nombre" en la nav para volver
// al perfil, sin tocar los controllers de cada vista.
document.addEventListener("DOMContentLoaded", async () => {
  const sid = qs("student");
  if (!sid) return;
  const tabs = document.querySelector(".topnav .tabs");
  if (!tabs) return;
  const a = document.createElement("a");
  a.className = "student-context";
  a.href = `/student?id=${encodeURIComponent(sid)}`;
  a.textContent = "← estudiante";
  tabs.after(a);
  try {
    const s = (await loadStudents()).find((x) => x.id === sid);
    if (s) a.textContent = `← ${s.nombre}`;
  } catch (_) { /* chip genérico si el fetch falla */ }
});

// Con contexto de estudiante, el select de videos muestra solo sus videos +
// las referencias de profesor (llamado por populateVideoSelect).
function studentFilter(videos, lib) {
  const sid = qs("student");
  if (!sid || !lib || !lib.videos) return videos;
  const kept = videos.filter((v) => {
    const t = lib.videos[v] || {};
    return t.student_id === sid || t.rol === "profesor";
  });
  return kept.length ? kept : videos;  // fallback: nunca dejar el select vacío
}
