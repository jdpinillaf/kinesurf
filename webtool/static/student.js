// Perfil de estudiante: datos editables, videos por maniobra, timeline por fecha.
// Global (sin módulos). Depende de api.js. Ruta: /student?id=<student_id>

const sid = qs("id");
let _student = null;
let _videos = [];

const status = document.getElementById("status");
const nombreIn = document.getElementById("sNombre");
const nivelIn = document.getElementById("sNivel");
const notasIn = document.getElementById("sNotas");

function flash(msg) {
  status.textContent = msg;
  setTimeout(() => { status.textContent = ""; }, 2500);
}

function fmtFecha(iso) {
  if (!iso) return "sin fecha";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// Fila de video con acciones a las 4 vistas (deep link con contexto ?student=).
function videoRow(v) {
  const row = document.createElement("div");
  row.className = "video-row";
  const links = [["Etiquetar", "/"], ["Comparar", "/compare"],
                 ["Secuencia", "/sequence"], ["3D", "/pose3d"]]
    .map(([label, base]) =>
      `<a class="chip chip-link" href="${viewUrl(base, v.video, sid)}">${label}</a>`)
    .join("");
  row.innerHTML = `
    <div class="video-row-main">
      <strong>${v.video}</strong>
      <span class="dim">${fmtFecha(v.fecha)}</span>
      <span class="video-actions">${links}</span>
    </div>`;
  const nota = document.createElement("input");
  nota.type = "text";
  nota.placeholder = "nota de esta sesión…";
  nota.value = v.nota || "";
  nota.addEventListener("change", async () => {
    await apiSend("/api/library/assign", "POST",
      { video: v.video, student_id: sid, nota: nota.value });
    flash("nota guardada");
  });
  const drop = document.createElement("button");
  drop.textContent = "desasignar";
  drop.title = "quitar de este estudiante (el video no se borra)";
  drop.addEventListener("click", async () => {
    await apiSend("/api/library/assign", "POST",
      { video: v.video, student_id: null });
    await refresh();
  });
  const foot = document.createElement("div");
  foot.className = "video-row-foot";
  foot.append(nota, drop);
  row.appendChild(foot);
  return row;
}

function renderVideos() {
  const byManeuver = new Map();
  for (const v of _videos) {
    const m = v.maniobra || "sin clasificar";
    if (!byManeuver.has(m)) byManeuver.set(m, []);
    byManeuver.get(m).push(v);
  }
  const host = document.getElementById("videosByManeuver");
  host.innerHTML = "";
  for (const [m, vids] of byManeuver) {
    const h = document.createElement("h3");
    h.className = "maneuver-title";
    h.innerHTML = `<span class="chip chip-accent">${m}</span> <span class="dim">${vids.length}</span>`;
    host.appendChild(h);
    for (const v of vids) host.appendChild(videoRow(v));
  }
  document.getElementById("noVideos").hidden = _videos.length > 0;

  // Timeline: mismos videos agrupados por fecha descendente (sesiones implícitas).
  const byDate = new Map();
  for (const v of _videos) {
    const f = v.fecha || "sin fecha";
    if (!byDate.has(f)) byDate.set(f, []);
    byDate.get(f).push(v);
  }
  const tl = document.getElementById("timeline");
  tl.innerHTML = "";
  for (const [f, vids] of byDate) {
    const item = document.createElement("div");
    item.className = "timeline-item";
    item.innerHTML = `<div class="timeline-date">${fmtFecha(f === "sin fecha" ? null : f)}</div>` +
      vids.map((v) =>
        `<div class="timeline-video">${v.video}` +
        (v.maniobra ? ` <span class="chip">${v.maniobra}</span>` : "") +
        (v.nota ? ` <span class="dim">— ${v.nota}</span>` : "") +
        ` <a class="dim" href="${viewUrl("/sequence", v.video, sid)}">secuencia →</a></div>`
      ).join("");
    tl.appendChild(item);
  }
}

async function refreshAssignSelect() {
  const unassigned = (await apiGet("/api/videos/unassigned")).videos;
  const sel = document.getElementById("assignSelect");
  sel.innerHTML = `<option value="">+ asignar video existente…</option>` +
    unassigned.map((v) => `<option value="${v.video}">${v.video}` +
      (v.maniobra ? ` (${v.maniobra})` : "") + `</option>`).join("");
}

async function refresh() {
  const [students, vids] = await Promise.all([
    loadStudents(),
    apiGet(`/api/students/${encodeURIComponent(sid)}/videos`).then((d) => d.videos),
  ]);
  _student = students.find((s) => s.id === sid);
  if (!_student) {
    document.querySelector(".page").innerHTML =
      `<p>Estudiante no encontrado. <a href="/dashboard">← volver</a></p>`;
    return;
  }
  _videos = vids;
  nombreIn.value = _student.nombre;
  nivelIn.value = _student.nivel || "";
  notasIn.value = _student.notas || "";
  document.title = `KineSurf — ${_student.nombre}`;
  document.getElementById("archiveBtn").textContent =
    _student.archivado ? "desarchivar" : "archivar";
  renderVideos();
  await refreshAssignSelect();
}

document.getElementById("saveBtn").addEventListener("click", async () => {
  await apiSend(`/api/students/${encodeURIComponent(sid)}`, "PATCH", {
    nombre: nombreIn.value.trim(),
    nivel: nivelIn.value,
    notas: notasIn.value,
  });
  flash("guardado ✓");
});

document.getElementById("archiveBtn").addEventListener("click", async () => {
  await apiSend(`/api/students/${encodeURIComponent(sid)}`, "PATCH",
    { archivado: !_student.archivado });
  await refresh();
});

document.getElementById("assignSelect").addEventListener("change", async (e) => {
  if (!e.target.value) return;
  await apiSend("/api/library/assign", "POST",
    { video: e.target.value, student_id: sid });
  await refresh();
});

refresh().catch((e) => flash(String(e)));
