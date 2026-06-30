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
// Umbral de visibility: por debajo, el punto es poco confiable (ocluido/adivinado por
// MediaPipe) → se dibuja distinto (hueco naranja + hueso punteado) para saber qué corregir.
const LOW_VIS = 0.5;

function createPane(root) {
  // ── Estado propio del pane (cerrado en el closure) ──────────────────────────
  const state = {
    video: null,
    frame: 0,
    meta: null,             // {fps, n_frames, width, height, has_landmarks}
    landmarks: null,
    world: null,            // world landmarks 3D (métricos) para ángulos 3D
    annotations: null,
    tool: "none",
    stride: 1,
    playing: false,
    frameByFrame: false,   // modo: play avanza lento, un frame a la vez
    ffDelay: 300,          // ms por frame en modo frame-a-frame
    clips: [],          // clips guardados de este video [{name,start,end}]
    clip: null,         // clip activo (acota la navegación) o null = video completo
    markIn: null,       // marca de inicio pendiente (frame)
    markOut: null,      // marca de fin pendiente (frame)
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
    ffToggle: $(".ffToggle"),
    ffDelay: $(".ffDelay"),
    frameLabel: $(".frameLabel"),
    playBtn: $(".playBtn"),
    prevBtn: $(".prevBtn"),
    nextBtn: $(".nextBtn"),
    undoBtn: $(".undoBtn"),
    clearBtn: $(".clearBtn"),
    saveBtn: $(".saveBtn"),
    status: $(".status"),
    metricsPanel: $(".metricsPanel"),
    clipSelect: $(".clipSelect"),
    markInBtn: $(".markInBtn"),
    markOutBtn: $(".markOutBtn"),
    clipRange: $(".clipRange"),
    clipNameInput: $(".clipNameInput"),
    saveClipBtn: $(".saveClipBtn"),
  };

  // El controlador (compare.js) setea esto para espejar acciones al gemelo.
  // onMetrics: hook que el controlador setea para recibir las métricas del frame actual.
  const pane = { root, onAction: null, onMetrics: null, metrics: [] };

  // ── Métricas biomecánicas del frame actual (metrics.js) ──────────────────────
  // Resolver que respeta las correcciones manuales de landmarks y escala a píxeles
  // del canvas (resolución nativa) para no distorsionar los ángulos por la proporción.
  // Resolver 2D: respeta correcciones manuales y escala a píxeles del canvas.
  function metricResolver2D() {
    const f = state.frame;
    return (idx) => {
      const corr = state.annotations?.corrections?.[f]?.[idx];
      if (corr) return { x: corr[0] * overlay.width, y: corr[1] * overlay.height, vis: 1 };
      const p = state.landmarks?.[f]?.[idx];
      if (!p || p[0] == null) return null;
      if (p[3] != null && p[3] < 0.5) return null;
      return { x: p[0] * overlay.width, y: p[1] * overlay.height, vis: p[3] == null ? 1 : p[3] };
    };
  }
  // Resolver 3D: world landmarks crudos (no refleja correcciones manuales, otro espacio).
  function metricResolver3D() {
    return makeResolver3D(state.world ? state.world[state.frame] : null);
  }
  function renderMetricsPanel() {
    if (!els.metricsPanel) return;
    els.metricsPanel.innerHTML = "";
    for (const m of pane.metrics) {
      const chip = document.createElement("span");
      chip.className = "chip";
      const v3 = m.isTilt ? "" : ` <span class="lbl">3D</span><span class="val">${fmtMetric(m.v3d)}</span>`;
      chip.innerHTML =
        `<span class="lbl">${m.label}</span><span class="lbl">2D</span>` +
        `<span class="val">${fmtMetric(m.v2d)}</span>${v3}`;
      els.metricsPanel.appendChild(chip);
    }
  }
  function updateMetrics() {
    pane.metrics = state.meta
      ? computeMetricsBoth(metricResolver2D(), metricResolver3D()) : [];
    renderMetricsPanel();
    if (pane.onMetrics) pane.onMetrics(pane.metrics);
  }

  // Notifica una acción de navegación para sync (guardado contra recursión).
  function emit(fn, args) {
    if (pane.onAction) pane.onAction({ fn, args });
  }

  // Dimensiona el .frame para que el video entre completo (contain) en el espacio
  // disponible del stage, manteniendo la proporción del video. Determinístico: no
  // depende de aspect-ratio CSS (que se comporta distinto en flujo vs flex).
  function fitFrame() {
    if (!state.meta) return;
    const stage = root.querySelector(".stage");
    const frameEl = root.querySelector(".frame");
    if (!stage || !frameEl) return;
    const aw = stage.clientWidth, ah = stage.clientHeight;
    const ar = state.meta.width / state.meta.height;
    let w = aw, h = aw / ar;     // intentar llenar el ancho
    if (h > ah) { h = ah; w = ah * ar; }   // si excede el alto, limitar por alto
    frameEl.style.width = Math.floor(w) + "px";
    frameEl.style.height = Math.floor(h) + "px";
  }

  // ── Clips (recorte por rango de frames) ───────────────────────────────────────
  // Rango navegable: [lo, hi]. Con un clip activo se acota a su [start, end].
  function bounds() {
    if (!state.meta) return [0, 0];
    const max = state.meta.n_frames - 1;
    if (state.clip) {
      return [Math.max(0, state.clip.start), Math.min(max, state.clip.end)];
    }
    return [0, max];
  }

  // Aplica el rango actual a slider/input y reencuadra el frame si quedó fuera.
  function applyBounds() {
    const [lo, hi] = bounds();
    els.slider.min = lo; els.slider.max = hi;
    els.frameInput.min = lo; els.frameInput.max = hi;
    render(state.frame < lo || state.frame > hi ? lo : state.frame);
  }

  function populateClips() {
    els.clipSelect.innerHTML = '<option value="">video completo</option>';
    state.clips.forEach((c, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = `${c.name} (${c.start}–${c.end})`;
      els.clipSelect.appendChild(o);
    });
    els.clipSelect.value = state.clip ? String(state.clips.indexOf(state.clip)) : "";
  }

  function updateClipRange() {
    const a = state.markIn, b = state.markOut;
    els.clipRange.textContent =
      `in: ${a == null ? "–" : a} · out: ${b == null ? "–" : b}`;
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
      // world landmarks 3D (para métricas 3D); puede tardar si aún no está en disco.
      try {
        state.world = (await (await fetch(
          `/api/worldlandmarks/${encodeURIComponent(video)}`)).json()).landmarks;
      } catch (e) { state.world = null; }
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
      // clips de este video
      const cl = await (await fetch(`/api/clips/${encodeURIComponent(video)}`)).json();
      state.clips = cl.clips || [];
      state.clip = null; state.markIn = null; state.markOut = null;
      populateClips();
      updateClipRange();
      for (const c of [base, overlay]) {
        c.width = state.meta.width;
        c.height = state.meta.height;
      }
      fitFrame();   // dimensionar el .frame al espacio disponible (contain)
      els.slider.min = 0; els.frameInput.min = 0;
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
    const [lo, hi] = bounds();
    n = Math.max(lo, Math.min(n, hi));
    state.frame = n;
    els.slider.value = n;
    els.frameInput.value = n;
    els.frameLabel.textContent = `${n} / ${hi}`;
    updateMetrics();   // depende solo de landmarks: refresca ya, sin esperar la imagen
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
    els.playBtn.textContent = "⏸ pausa";
    if (propagate) emit("play", []);
    const token = ++_playToken;
    const [lo, hi] = bounds();
    const fps = state.meta.fps || 30;
    if (state.frame >= hi) await render(lo);   // reiniciar al inicio del rango
    while (state.playing && token === _playToken) {
      const next = state.frame + state.stride;
      if (next > hi) { pause(false); break; }
      const t0 = performance.now();
      await render(next);                        // espera el pintado real
      if (token !== _playToken) break;           // pausado durante la carga
      // modo frame-a-frame: pausa fija por frame; si no, ritmo de tiempo real
      const target = state.frameByFrame
        ? state.ffDelay
        : 1000 * state.stride / fps;
      const elapsed = performance.now() - t0;
      if (elapsed < target) {
        await new Promise((r) => setTimeout(r, target - elapsed));
      }
    }
  }
  function pause(propagate = true) {
    _playToken++;              // cancela el loop en curso
    state.playing = false;
    els.playBtn.textContent = "▶ play";
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

  // Visibility de un joint: una corrección manual cuenta como confiable (1).
  function jointVis(frame, idx) {
    if (state.annotations?.corrections?.[frame]?.[idx]) return 1;
    const lm = state.landmarks?.[frame]?.[idx];
    return lm && lm[3] != null ? lm[3] : 1;
  }

  function drawSkeleton() {
    const f = state.frame;
    octx.lineWidth = 2;
    // huesos: punteado y atenuado si alguno de sus extremos es de baja confianza
    for (const [a, b] of BONES) {
      const pa = getPoint(f, a), pb = getPoint(f, b);
      if (!pa || !pb) continue;
      const low = jointVis(f, a) < LOW_VIS || jointVis(f, b) < LOW_VIS;
      octx.strokeStyle = low ? "rgba(57,153,221,.35)" : "#39d";
      octx.setLineDash(low ? [5, 4] : []);
      octx.beginPath();
      octx.moveTo(pa.x, pa.y); octx.lineTo(pb.x, pb.y); octx.stroke();
    }
    octx.setLineDash([]);
    // joints: relleno amarillo si confiable; círculo hueco naranja si baja visibility
    for (let i = 0; i < 33; i++) {
      const p = getPoint(f, i);
      if (!p) continue;
      if (jointVis(f, i) < LOW_VIS) {
        octx.strokeStyle = "#ff8c1a"; octx.lineWidth = 2;
        octx.beginPath(); octx.arc(p.x, p.y, 4.5, 0, 2 * Math.PI); octx.stroke();
      } else {
        octx.fillStyle = "#fd3";
        octx.beginPath(); octx.arc(p.x, p.y, 4, 0, 2 * Math.PI); octx.fill();
      }
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
  window.addEventListener("resize", fitFrame);
  els.playBtn.addEventListener("click", () => togglePlay());
  els.prevBtn.addEventListener("click", () => step(-1));
  els.nextBtn.addEventListener("click", () => step(1));
  els.slider.addEventListener("input", (e) => goTo(+e.target.value));
  els.frameInput.addEventListener("change", (e) => goTo(+e.target.value));
  els.strideInput.addEventListener("change", (e) => {
    state.stride = Math.max(1, parseInt(e.target.value, 10) || 1);
    els.strideInput.value = state.stride;
  });
  els.ffToggle.addEventListener("change", (e) => {
    state.frameByFrame = e.target.checked;
  });
  els.ffDelay.addEventListener("change", (e) => {
    state.ffDelay = Math.max(50, parseInt(e.target.value, 10) || 300);
    els.ffDelay.value = state.ffDelay;
  });

  // ── Clips: seleccionar, marcar in/out, guardar ────────────────────────────────
  els.clipSelect.addEventListener("change", (e) => {
    const v = e.target.value;
    state.clip = v === "" ? null : (state.clips[+v] || null);
    applyBounds();
  });
  els.markInBtn.addEventListener("click", () => {
    state.markIn = state.frame; updateClipRange();
  });
  els.markOutBtn.addEventListener("click", () => {
    state.markOut = state.frame; updateClipRange();
  });
  els.saveClipBtn.addEventListener("click", async () => {
    if (!state.video) return;
    if (state.markIn == null || state.markOut == null) {
      els.status.textContent = "marcá inicio y fin";
      setTimeout(() => (els.status.textContent = ""), 2000);
      return;
    }
    const start = Math.min(state.markIn, state.markOut);
    const end = Math.max(state.markIn, state.markOut);
    const name = (els.clipNameInput.value || `clip ${state.clips.length + 1}`).trim();
    const clip = { name, start, end };
    state.clips.push(clip);
    try {
      const r = await fetch(`/api/clips/${encodeURIComponent(state.video)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video: state.video, clips: state.clips }),
      });
      const ok = r.ok && (await r.json()).ok;
      els.status.textContent = ok ? "clip guardado ✓" : "error";
    } catch (err) {
      els.status.textContent = "error";
    }
    setTimeout(() => (els.status.textContent = ""), 2000);
    // seleccionar el clip recién creado y acotar a su rango
    state.clip = clip;
    state.markIn = null; state.markOut = null;
    els.clipNameInput.value = "";
    populateClips();
    updateClipRange();
    applyBounds();
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
    updateMetrics();   // la corrección manual cambia el ángulo
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
