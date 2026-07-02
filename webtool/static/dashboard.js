// Dashboard del coach: grid de estudiantes + videos sin asignar.
// Global (sin módulos), como el resto de vistas. Depende de api.js.

let _students = [];
let _unassigned = [];

const grid = document.getElementById("studentGrid");
const emptyMsg = document.getElementById("emptyMsg");
const searchBox = document.getElementById("searchBox");
const showArchived = document.getElementById("showArchived");
const unassignedSection = document.getElementById("unassignedSection");
const unassignedList = document.getElementById("unassignedList");
const dialog = document.getElementById("studentDialog");

function fmtFecha(iso) {
  if (!iso) return "sin videos";
  const [y, m, d] = iso.split("-");
  return `último: ${d}/${m}/${y}`;
}

function studentCard(s) {
  const card = document.createElement("a");
  card.className = "card student-card" + (s.archivado ? " archived" : "");
  card.href = `/student?id=${encodeURIComponent(s.id)}`;
  const chips = s.maniobras.map((m) => `<span class="chip">${m}</span>`).join("");
  card.innerHTML = `
    <div class="card-title">${s.nombre}</div>
    <div class="card-sub">
      ${s.nivel ? `<span class="chip chip-accent">${s.nivel}</span>` : ""}
      <span class="dim">${s.n_videos} video${s.n_videos === 1 ? "" : "s"} · ${fmtFecha(s.ultima_fecha)}</span>
    </div>
    <div class="chips">${chips}</div>`;
  return card;
}

function render() {
  const q = searchBox.value.trim().toLowerCase();
  const visible = _students.filter((s) =>
    (showArchived.checked || !s.archivado) &&
    (!q || s.nombre.toLowerCase().includes(q)));
  grid.innerHTML = "";
  for (const s of visible) grid.appendChild(studentCard(s));
  emptyMsg.hidden = visible.length > 0;

  unassignedSection.hidden = _unassigned.length === 0;
  unassignedList.innerHTML = "";
  for (const v of _unassigned) unassignedList.appendChild(unassignedRow(v));
}

function unassignedRow(v) {
  const row = document.createElement("div");
  row.className = "unassigned-row";
  const sel = document.createElement("select");
  sel.innerHTML = `<option value="">asignar a…</option>` +
    _students.filter((s) => !s.archivado)
      .map((s) => `<option value="${s.id}">${s.nombre}</option>`).join("");
  sel.addEventListener("change", async () => {
    if (!sel.value) return;
    await apiSend("/api/library/assign", "POST",
      { video: v.video, student_id: sel.value });
    await refresh();
  });
  const label = document.createElement("span");
  label.innerHTML = `<strong>${v.video}</strong>` +
    (v.maniobra ? ` <span class="chip">${v.maniobra}</span>` : "");
  const open = document.createElement("a");
  open.href = viewUrl("/", v.video);
  open.textContent = "ver";
  open.className = "dim";
  row.append(label, open, sel);
  return row;
}

async function refresh() {
  [_students, _unassigned] = await Promise.all([
    loadStudents(),
    apiGet("/api/videos/unassigned").then((d) => d.videos),
  ]);
  render();
}

document.getElementById("addStudentBtn").addEventListener("click", () => {
  document.getElementById("studentForm").reset();
  dialog.showModal();
});

dialog.addEventListener("close", async () => {
  if (dialog.returnValue !== "ok") return;
  const nombre = document.getElementById("fNombre").value.trim();
  if (!nombre) return;
  const s = await apiSend("/api/students", "POST", {
    nombre,
    nivel: document.getElementById("fNivel").value,
    notas: document.getElementById("fNotas").value,
  });
  location.href = `/student?id=${encodeURIComponent(s.id)}`;
});

searchBox.addEventListener("input", render);
showArchived.addEventListener("change", render);

refresh().catch((e) => { emptyMsg.hidden = false; emptyMsg.textContent = String(e); });
