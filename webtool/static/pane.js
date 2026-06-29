// pane.js — un reproductor/anotador de UN video, instanciable N veces.
//
// `createPane(root)` encapsula todo el estado y los listeners de un video dentro
// del subárbol DOM `root` (sin variables globales), de modo que dos panes coexisten
// sin pisarse. Porta la lógica del visor de 1 video (app.js) parametrizada por pane,
// y agrega: play/pausa temporizado, stride ("cada N frames") y un hook `onAction`
// para que un controlador externo (compare.js) espeje las acciones al pane gemelo.
//
// Contrato DOM esperado dentro de `root` (por clase, no por id, para que coexistan):
//   select.videoSelect, input.skeletonToggle,
//   .tools button[data-tool="none|landmark|angle|pen"], button.undoBtn/.clearBtn/.saveBtn,
//   canvas.base, canvas.overlay,
//   button.playBtn/.prevBtn/.nextBtn, input.slider, input.frameInput, input.strideInput,
//   span.frameLabel, span.status

const BONES = [
  [11, 13], [13, 15], [12, 14], [14, 16],        // brazos
  [11, 12], [23, 24], [11, 23], [12, 24],         // torso
  [23, 25], [25, 27], [24, 26], [26, 28],         // piernas
];
const PEN_COLOR = "#f33";

function createPane(root) {
  // ── Estado propio del pane (cerrado en el closure) ──────────────────────────
  const state = {
    video: null,
    frame: 0,
    meta: null,             // {fps, n_frames, width, height, has_landmarks}
    landmarks: null,
    annotations: null,
    tool: "none",
    stride: 1,
    playing: false,
  };
  let _frameSeq = 0;        // descarta paints de frames viejos (navegación rápida)
  let dragIdx = null;       // landmark en arrastre (o null)
  let penStroke = null;     // trazo activo (o null)
  let anglePts = [];        // clicks A,B,C acumulados (px)
  let _playToken = 0;       // cancela el loop de play en curso (pausa / nuevo play)
  let hovered = false;      // el mouse está sobre este pane (para teclado)

  const $ = (sel) => root.querySelector(sel);
  const base = $(".base");
  const overlay = $(".overlay");
  const bctx = base.getContext("2d");
  const octx = overlay.getContext("2d");
  const els = {
    videoSelect: $(".videoSelect"),
    skeletonToggle: $(".skeletonToggle"),
    slider: $(".slider"),
    frameInput: $(".frameInput"),
    strideInput: $(".strideInput"),
    frameLabel: $(".frameLabel"),
    playBtn: $(".playBtn"),
    prevBtn: $(".prevBtn"),
    nextBtn: $(".nextBtn"),
    undoBtn: $(".undoBtn"),
    clearBtn: $(".clearBtn"),
    saveBtn: $(".saveBtn"),
    status: $(".status"),
  };

  // El controlador (compare.js) setea esto para espejar acciones al gemelo.
  const pane = { root, onAction: null };

  // Notifica una acción de navegación para sync (guardado contra recursión).
  function emit(fn, args) {
    if (pane.onAction) pane.onAction({ fn, args });
  }

  // ── Carga de videos ──────────────────────────────────────────────────────────
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
      return videos;
    } catch (err) {
      els.status.textContent = "error cargando: " + err.message;
      return [];
    }
  }

  async function load(video) {
    pause(false);
    try {
      state.video = video;
      els.videoSelect.value = video;
      state.meta = await (await fetch(`/api/meta/${encodeURIComponent(video)}`)).json();
      const lr = await fetch(`/api/landmarks/${encodeURIComponent(video)}`);
      state.landmarks = (await lr.json()).landmarks;
      // Clamp n_frames a la cantidad real de landmarks (CAP_PROP_FRAME_COUNT
      // sobre-reporta en .MOV de iPhone). Guard: no clampear si está vacío.
      if (Array.isArray(state.landmarks) && state.landmarks.length > 0
          && state.landmarks.length < state.meta.n_frames) {
        state.meta.n_frames = state.landmarks.length;
      }
      state.annotations = await (await fetch(
        `/api/annotations/${encodeURIComponent(video)}`)).json();
      state.annotations.corrections = state.annotations.corrections || {};
      state.annotations.angles = state.annotations.angles || [];
      state.annotations.drawings = state.annotations.drawings || {};
      for (const c of [base, overlay]) {
        c.width = state.meta.width;
        c.height = state.meta.height;
      }
      // proporción del video para que .frame escale a "contain" dentro del stage
      const frameEl = root.querySelector(".frame");
      if (frameEl) frameEl.style.aspectRatio = (state.meta.width / state.meta.height).toString();
      els.slider.max = state.meta.n_frames - 1;
      els.frameInput.max = state.meta.n_frames - 1;
      // toggle de esqueleto: deshabilitar si no hay landmarks
      const hasLm = Array.isArray(state.landmarks) && state.landmarks.length > 0;
      els.skeletonToggle.disabled = !hasLm;
      if (!hasLm) els.skeletonToggle.checked = false;
      await render(0);
    } catch (err) {
      els.status.textContent = "error cargando: " + err.message;
    }
  }

  // ── Pintado de un frame (async, con guard de secuencia) ──────────────────────
  async function render(n) {
    if (!state.meta) return;
    anglePts = [];
    n = Math.max(0, Math.min(n, state.meta.n_frames - 1));
    state.frame = n;
    els.slider.value = n;
    els.frameInput.value = n;
    els.frameLabel.textContent = `${n} / ${state.meta.n_frames - 1}`;
    const seq = ++_frameSeq;
    await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        if (seq !== _frameSeq) return resolve();   // un frame más nuevo fue pedido
        bctx.drawImage(img, 0, 0, base.width, base.height);
        redrawOverlay();
        resolve();
      };
      img.onerror = resolve;
      img.src = `/api/frame/${encodeURIComponent(state.video)}/${n}`;
    });
  }

  // Navegación pública (mirroreable). propagate=false cuando viene del gemelo.
  function goTo(n, propagate = true) {
    render(n);
    if (propagate) emit("goTo", [n]);
  }
  function step(dir, propagate = true) {
    if (!state.meta) return;
    render(state.frame + dir * state.stride);
    if (propagate) emit("step", [dir]);
  }

  // ── Play / pausa ──────────────────────────────────────────────────────────────
  // Loop auto-agendado que ESPERA a que cada frame se pinte antes del siguiente.
  // Clave: con setInterval, si cargar el JPEG tarda más que el intervalo, el guard
  // anti-stale descarta los repintados y la imagen se ve congelada. Al await-ear
  // render() cada frame se pinta sí o sí; el ritmo se auto-ajusta a la velocidad de
  // carga (a lo sumo tiempo-real = 1000*stride/fps por frame).
  async function play(propagate = true) {
    if (state.playing || !state.meta) return;
    state.playing = true;
    els.playBtn.textContent = "⏸";
    if (propagate) emit("play", []);
    const token = ++_playToken;
    const last = state.meta.n_frames - 1;
    const fps = state.meta.fps || 30;
    if (state.frame >= last) await render(0);   // reiniciar si estaba al final
    while (state.playing && token === _playToken) {
      const next = state.frame + state.stride;
      if (next > last) { pause(false); break; }
      const t0 = performance.now();
      await render(next);                        // espera el pintado real
      if (token !== _playToken) break;           // pausado durante la carga
      const target = 1000 * state.stride / fps;
      const elapsed = performance.now() - t0;
      if (elapsed < target) {
        await new Promise((r) => setTimeout(r, target - elapsed));
      }
    }
  }
  function pause(propagate = true) {
    _playToken++;              // cancela el loop en curso
    state.playing = false;
    els.playBtn.textContent = "▶";
    if (propagate) emit("pause", []);
  }
  function togglePlay() {
    state.playing ? pause() : play();
  }

  // ── Overlay: esqueleto, ángulos, trazos ──────────────────────────────────────
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

  function angleDeg(a, b, c) {
    const v1 = { x: a.x - b.x, y: a.y - b.y };
    const v2 = { x: c.x - b.x, y: c.y - b.y };
    const dot = v1.x * v2.x + v1.y * v2.y;
    const den = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) + 1e-9;
    return Math.acos(Math.max(-1, Math.min(1, dot / den))) * 180 / Math.PI;
  }

  function drawAngles() {
    if (!state.annotations?.angles) return;
    octx.strokeStyle = "#6f6";
    octx.fillStyle = "#6f6";
    octx.font = "16px sans-serif";
    for (const a of state.annotations.angles) {
      if (a.frame !== state.frame) continue;
      const pts = a.points.map((p) => ({ x: p[0] * overlay.width, y: p[1] * overlay.height }));
      octx.beginPath();
      octx.moveTo(pts[0].x, pts[0].y);
      octx.lineTo(pts[1].x, pts[1].y);
      octx.lineTo(pts[2].x, pts[2].y);
      octx.stroke();
      octx.fillText(`${a.value.toFixed(0)}°`, pts[1].x + 8, pts[1].y - 8);
    }
  }

  function drawPenStrokes() {
    const strokes = state.annotations?.drawings?.[state.frame] || [];
    octx.lineWidth = 3;
    octx.lineCap = "round";
    for (const s of strokes) {
      octx.strokeStyle = s.color || PEN_COLOR;
      octx.beginPath();
      s.stroke.forEach((p, i) => {
        const x = p[0] * overlay.width, y = p[1] * overlay.height;
        if (i === 0) octx.moveTo(x, y); else octx.lineTo(x, y);
      });
      octx.stroke();
    }
  }

  function redrawOverlay() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (els.skeletonToggle.checked) drawSkeleton();
    drawAngles();
    drawPenStrokes();
  }

  // ── Input de mouse ────────────────────────────────────────────────────────────
  function evtPos(e) {
    const r = overlay.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (overlay.width / r.width),
      y: (e.clientY - r.top) * (overlay.height / r.height),
    };
  }

  function nearestLandmark(pos, maxDist = 18) {
    let best = null, bestD = maxDist;
    for (let i = 0; i < 33; i++) {
      const p = getPoint(state.frame, i);
      if (!p) continue;
      const d = Math.hypot(p.x - pos.x, p.y - pos.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // ── Listeners ──────────────────────────────────────────────────────────────────
  els.videoSelect.addEventListener("change", (e) => load(e.target.value));
  els.skeletonToggle.addEventListener("change", redrawOverlay);
  els.playBtn.addEventListener("click", () => togglePlay());
  els.prevBtn.addEventListener("click", () => step(-1));
  els.nextBtn.addEventListener("click", () => step(1));
  els.slider.addEventListener("input", (e) => goTo(+e.target.value));
  els.frameInput.addEventListener("change", (e) => goTo(+e.target.value));
  els.strideInput.addEventListener("change", (e) => {
    state.stride = Math.max(1, parseInt(e.target.value, 10) || 1);
    els.strideInput.value = state.stride;
  });

  // teclado: solo cuando el mouse está sobre este pane
  root.addEventListener("mouseenter", () => { hovered = true; });
  root.addEventListener("mouseleave", () => { hovered = false; });
  document.addEventListener("keydown", (e) => {
    if (!hovered || e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
    if (e.key === " ") { e.preventDefault(); togglePlay(); }
  });

  // herramientas
  const toolBtns = root.querySelectorAll(".tools button[data-tool]");
  toolBtns.forEach((b) => {
    b.addEventListener("click", () => {
      state.tool = b.dataset.tool;
      anglePts = [];
      toolBtns.forEach((x) => x.classList.toggle("active", x === b));
    });
  });

  // corregir landmark (drag)
  overlay.addEventListener("mousedown", (e) => {
    if (state.tool !== "landmark") return;
    dragIdx = nearestLandmark(evtPos(e));
  });
  overlay.addEventListener("mousemove", (e) => {
    if (state.tool !== "landmark" || dragIdx === null) return;
    const pos = evtPos(e);
    const f = state.frame;
    state.annotations.corrections = state.annotations.corrections || {};
    state.annotations.corrections[f] = state.annotations.corrections[f] || {};
    state.annotations.corrections[f][dragIdx] =
      [pos.x / overlay.width, pos.y / overlay.height];
    redrawOverlay();
  });

  // dibujo libre (pen)
  overlay.addEventListener("mousedown", (e) => {
    if (state.tool !== "pen") return;
    penStroke = { tool: "pen", stroke: [], color: PEN_COLOR };
    const f = state.frame;
    state.annotations.drawings[f] = state.annotations.drawings[f] || [];
    state.annotations.drawings[f].push(penStroke);
  });
  overlay.addEventListener("mousemove", (e) => {
    if (state.tool !== "pen" || !penStroke) return;
    const p = evtPos(e);
    penStroke.stroke.push([p.x / overlay.width, p.y / overlay.height]);
    redrawOverlay();
  });
  window.addEventListener("mouseup", () => { dragIdx = null; penStroke = null; });

  // ángulo manual (3 clicks)
  overlay.addEventListener("click", (e) => {
    if (state.tool !== "angle") return;
    anglePts.push(evtPos(e));
    if (anglePts.length === 3) {
      const [a, b, c] = anglePts;
      state.annotations.angles = state.annotations.angles || [];
      state.annotations.angles.push({
        frame: state.frame,
        points: anglePts.map((p) => [p.x / overlay.width, p.y / overlay.height]),
        value: angleDeg(a, b, c),
        label: "",
      });
      anglePts = [];
      redrawOverlay();
    }
  });

  // undo / clear por frame
  els.undoBtn.addEventListener("click", () => {
    const f = state.frame;
    const d = state.annotations.drawings[f];
    if (d && d.length) { d.pop(); redrawOverlay(); return; }
    const idx = [...(state.annotations.angles || [])].reverse().findIndex((a) => a.frame === f);
    if (idx >= 0) {
      state.annotations.angles.splice(state.annotations.angles.length - 1 - idx, 1);
      redrawOverlay();
    }
  });
  els.clearBtn.addEventListener("click", () => {
    const f = state.frame;
    delete state.annotations.drawings[f];
    delete state.annotations.corrections[f];
    state.annotations.angles = (state.annotations.angles || []).filter((a) => a.frame !== f);
    redrawOverlay();
  });

  // guardar
  els.saveBtn.addEventListener("click", async () => {
    if (!state.video) return;
    state.annotations.video = state.video;
    try {
      const r = await fetch(`/api/annotations/${encodeURIComponent(state.video)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.annotations),
      });
      const ok = r.ok && (await r.json()).ok;
      els.status.textContent = ok ? "guardado ✓" : "error";
    } catch (err) {
      els.status.textContent = "error";
    }
    setTimeout(() => (els.status.textContent = ""), 2000);
  });

  // API pública del pane (para compare.js)
  Object.assign(pane, {
    loadVideos, load, goTo, step, play, pause, togglePlay,
    getVideo: () => state.video,
  });
  return pane;
}
