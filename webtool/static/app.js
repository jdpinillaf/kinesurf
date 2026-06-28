// Estado global del motor visual.
const state = {
  video: null,
  frame: 0,
  meta: null,        // {fps, n_frames, width, height, has_landmarks}
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
  const r = await fetch("/api/videos");
  const { videos } = await r.json();
  els.videoSelect.innerHTML = "";
  for (const v of videos) {
    const opt = document.createElement("option");
    opt.value = opt.textContent = v;
    els.videoSelect.appendChild(opt);
  }
  if (videos.length) await selectVideo(videos[0]);
}

async function selectVideo(video) {
  state.video = video;
  const r = await fetch(`/api/meta/${encodeURIComponent(video)}`);
  state.meta = await r.json();
  // Dimensionar ambos canvas al tamaño real del frame.
  for (const c of [base, overlay]) {
    c.width = state.meta.width;
    c.height = state.meta.height;
  }
  els.slider.max = state.meta.n_frames - 1;
  els.frameInput.max = state.meta.n_frames - 1;
  await showFrame(0);
}

async function showFrame(n) {
  if (!state.meta) return;
  n = Math.max(0, Math.min(n, state.meta.n_frames - 1));
  state.frame = n;
  els.slider.value = n;
  els.frameInput.value = n;
  els.frameLabel.textContent = `${n} / ${state.meta.n_frames - 1}`;
  const img = new Image();
  img.onload = () => {
    bctx.drawImage(img, 0, 0, base.width, base.height);
    redrawOverlay();   // definido en tasks posteriores
  };
  img.src = `/api/frame/${encodeURIComponent(state.video)}/${n}`;
}

// Placeholder hasta Task 7+; se redefine al añadir overlays.
function redrawOverlay() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
}

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
