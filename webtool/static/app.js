// Estado global del motor visual.
const state = {
  video: null,
  frame: 0,
  meta: null,        // {fps, n_frames, width, height, has_landmarks}
  landmarks: null,
  annotations: null,
};

const base = document.getElementById("base");
const overlay = document.getElementById("overlay");
const bctx = base.getContext("2d");
const octx = overlay.getContext("2d");

const els = {
  videoSelect: document.getElementById("videoSelect"),
  slider: document.getElementById("slider"),
  frameInput: document.getElementById("frameInput"),
  frameLabel: document.getElementById("frameLabel"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  status: document.getElementById("status"),
};

async function loadVideos() {
  try {
    const r = await fetch("/api/videos");
    const { videos } = await r.json();
    els.videoSelect.innerHTML = "";
    for (const v of videos) {
      const opt = document.createElement("option");
      opt.value = opt.textContent = v;
      els.videoSelect.appendChild(opt);
    }
    if (videos.length) await selectVideo(videos[0]);
  } catch (err) {
    els.status.textContent = "error cargando: " + err.message;
  }
}

async function selectVideo(video) {
  try {
    state.video = video;
    const r = await fetch(`/api/meta/${encodeURIComponent(video)}`);
    state.meta = await r.json();
    const lr = await fetch(`/api/landmarks/${encodeURIComponent(video)}`);
    state.landmarks = (await lr.json()).landmarks;
    state.annotations = await (await fetch(
      `/api/annotations/${encodeURIComponent(video)}`)).json();
    // Dimensionar ambos canvas al tamaño real del frame.
    for (const c of [base, overlay]) {
      c.width = state.meta.width;
      c.height = state.meta.height;
    }
    els.slider.max = state.meta.n_frames - 1;
    els.frameInput.max = state.meta.n_frames - 1;
    await showFrame(0);
  } catch (err) {
    els.status.textContent = "error cargando: " + err.message;
  }
}

let _frameSeq = 0;   // discards stale async frame loads (rapid nav)

async function showFrame(n) {
  if (!state.meta) return;
  n = Math.max(0, Math.min(n, state.meta.n_frames - 1));
  state.frame = n;
  els.slider.value = n;
  els.frameInput.value = n;
  els.frameLabel.textContent = `${n} / ${state.meta.n_frames - 1}`;
  const seq = ++_frameSeq;
  await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (seq !== _frameSeq) return resolve();   // a newer frame was requested; drop this paint
      bctx.drawImage(img, 0, 0, base.width, base.height);
      redrawOverlay();
      resolve();
    };
    img.onerror = resolve;   // don't hang the promise on a failed load
    img.src = `/api/frame/${encodeURIComponent(state.video)}/${n}`;
  });
}

// Pares de landmarks a conectar (subconjunto relevante del pop-up).
const BONES = [
  [11, 13], [13, 15], [12, 14], [14, 16],        // brazos
  [11, 12], [23, 24], [11, 23], [12, 24],         // torso
  [23, 25], [25, 27], [24, 26], [26, 28],         // piernas
];

// Devuelve el punto en px de canvas para (frame, idx), con corrección si existe, o null.
function getPoint(frame, idx) {
  const corr = state.annotations?.corrections?.[frame]?.[idx];
  if (corr) return { x: corr[0] * overlay.width, y: corr[1] * overlay.height };
  const lm = state.landmarks?.[frame]?.[idx];
  if (!lm || lm[0] === null) return null;
  return { x: lm[0] * overlay.width, y: lm[1] * overlay.height };
}

function drawSkeleton() {
  const f = state.frame;
  octx.lineWidth = 2;
  octx.strokeStyle = "#39d";
  for (const [a, b] of BONES) {
    const pa = getPoint(f, a), pb = getPoint(f, b);
    if (!pa || !pb) continue;
    octx.beginPath();
    octx.moveTo(pa.x, pa.y); octx.lineTo(pb.x, pb.y); octx.stroke();
  }
  octx.fillStyle = "#fd3";
  for (let i = 0; i < 33; i++) {
    const p = getPoint(f, i);
    if (!p) continue;
    octx.beginPath(); octx.arc(p.x, p.y, 4, 0, 2 * Math.PI); octx.fill();
  }
}

function redrawOverlay() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (document.getElementById("skeletonToggle").checked) drawSkeleton();
}

document.getElementById("skeletonToggle")
  .addEventListener("change", redrawOverlay);

els.videoSelect.addEventListener("change", (e) => selectVideo(e.target.value));
els.prevBtn.addEventListener("click", () => showFrame(state.frame - 1));
els.nextBtn.addEventListener("click", () => showFrame(state.frame + 1));
els.slider.addEventListener("input", (e) => showFrame(+e.target.value));
els.frameInput.addEventListener("change", (e) => showFrame(+e.target.value));
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "ArrowLeft") showFrame(state.frame - 1);
  if (e.key === "ArrowRight") showFrame(state.frame + 1);
});

loadVideos();
