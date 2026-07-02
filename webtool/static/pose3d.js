// pose3d.js — viewer 3D 360° de los vectores del cuerpo (world landmarks).
// Renderiza el esqueleto MediaPipe (33 joints, metros, origen en la cadera) con
// Three.js vendoreado (webtool/static/vendor/, sin CDN en runtime). Órbita/zoom
// con OrbitControls. Los world landmarks llegan suavizados del server (?smooth=1)
// para quitar el temblor del eje de profundidad (z monocular).
//
// Ojo coordenadas: en MediaPipe la Y crece hacia ABAJO (convención imagen);
// en la escena 3D la Y crece hacia arriba → se invierte al mapear.

import * as THREE from "three";
import { OrbitControls } from "/static/vendor/OrbitControls.js";

// Mismos huesos que pane.js (BONES) — duplicado aquí porque este archivo es módulo ES.
const BONES3D = [
  [11, 13], [13, 15], [12, 14], [14, 16],        // brazos
  [11, 12], [23, 24], [11, 23], [12, 24],         // torso
  [23, 25], [25, 27], [24, 26], [26, 28],         // piernas
  [27, 31], [28, 32],                              // pies
];
const LEFT = new Set([11, 13, 15, 23, 25, 27, 31]);
const RIGHT = new Set([12, 14, 16, 24, 26, 28, 32]);
// Solo el esqueleto core: brazos, piernas, pies. La cara (1-10) y los dedos (17-22)
// no tienen huesos y se ven como racimos sueltos → no se dibujan; la cabeza se
// representa con UNA esfera (punto medio de orejas) + cuello.
const CORE_JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32];
const MIN_DRAW = 0.2;         // por debajo (y sin relleno): no dibujar nada
const DIM_VIS = 0.5;          // por debajo (o estimado por relleno): translúcido
const JOINT_R = 0.028;        // radio de esfera de joint (m)
const BONE_R = 0.014;         // radio de cilindro de hueso (m)
const HEAD_R = 0.09;          // radio de la esfera de cabeza (m)

// Paleta (armoniza con el tema Océano claro)
const COL_LEFT = 0x0e7c86;    // teal — lado izquierdo
const COL_RIGHT = 0xe76f51;   // coral — lado derecho
const COL_MID = 0x5b6b77;     // gris azulado — centro (nariz, huesos torso)
const COL_BG = 0xfaf9f6;      // fondo arena del tema

const els = {
  videoSelect: document.getElementById("videoSelect"),
  smoothToggle: document.getElementById("smoothToggle"),
  fillToggle: document.getElementById("fillToggle"),
  status: document.getElementById("status"),
  slider: document.getElementById("slider"),
  playBtn: document.getElementById("playBtn"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  frameLabel: document.getElementById("frameLabel"),
  stage: document.getElementById("stage3d"),
};

const state = {
  video: null, world: null, rawWorld: null, fps: 30,
  frame: 0, playing: false, groundY: 0,
};

// ── Escena ────────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(COL_BG);

const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);
camera.position.set(1.6, 0.6, 2.4);

// El renderer puede fallar (navegador/entorno sin WebGL): degradar con mensaje
// en vez de romper toda la vista.
let renderer = null, controls = null;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  els.stage.appendChild(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, -0.2, 0);
} catch (e) {
  els.status.textContent = "este navegador no soporta WebGL (no se puede renderizar 3D)";
}

scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c4cc, 1.1));
const dir = new THREE.DirectionalLight(0xffffff, 1.2);
dir.position.set(2, 3, 2);
scene.add(dir);

// suelo: grid a la altura de los pies (se recoloca al cargar cada video)
const grid = new THREE.GridHelper(4, 20, 0x8b99a4, 0xd2cec2);
scene.add(grid);

// joints core: esferas; huesos: cilindros unitarios que se orientan por frame.
// Cada lado tiene material sólido + translúcido (para puntos estimados/baja confianza).
const jointMat = {
  left: new THREE.MeshStandardMaterial({ color: COL_LEFT }),
  right: new THREE.MeshStandardMaterial({ color: COL_RIGHT }),
  mid: new THREE.MeshStandardMaterial({ color: COL_MID }),
};
const jointMatDim = {
  left: new THREE.MeshStandardMaterial({ color: COL_LEFT, transparent: true, opacity: 0.35 }),
  right: new THREE.MeshStandardMaterial({ color: COL_RIGHT, transparent: true, opacity: 0.35 }),
  mid: new THREE.MeshStandardMaterial({ color: COL_MID, transparent: true, opacity: 0.35 }),
};
function sideOf(i) { return LEFT.has(i) ? "left" : RIGHT.has(i) ? "right" : "mid"; }

const sphereGeo = new THREE.SphereGeometry(JOINT_R, 16, 12);
const joints = {};                       // idx core -> Mesh
for (const i of CORE_JOINTS) {
  const m = new THREE.Mesh(sphereGeo, jointMat[sideOf(i)]);
  m.visible = false;
  scene.add(m);
  joints[i] = m;
}
const boneGeo = new THREE.CylinderGeometry(BONE_R, BONE_R, 1, 10);
function mkBone(side) {
  const m = new THREE.Mesh(boneGeo, jointMat[side]);
  m.visible = false;
  scene.add(m);
  return m;
}
const bones = BONES3D.map(([a, b]) => {
  const side = (LEFT.has(a) && LEFT.has(b)) ? "left"
    : (RIGHT.has(a) && RIGHT.has(b)) ? "right" : "mid";
  const m = mkBone(side);
  m.userData.side = side;
  return m;
});
// cabeza única (punto medio de orejas) + cuello al punto medio de hombros
const headMesh = new THREE.Mesh(new THREE.SphereGeometry(HEAD_R, 20, 16), jointMat.mid);
headMesh.visible = false;
scene.add(headMesh);
const neckBone = mkBone("mid");
neckBone.userData.side = "mid";

// ── Mapeo landmark → escena ───────────────────────────────────────────────────
// Devuelve {v: Vector3, dim: bool} — dim = estimado por relleno (EST_VIS) o baja
// confianza → se dibuja translúcido. Por debajo de MIN_DRAW (sin relleno): null.
function ptOf(frame, i) {
  const p = state.world?.[frame]?.[i];
  if (!p || p[0] == null) return null;
  const vis = p[3] == null ? 1 : p[3];
  // isEstimated (occlusion.js, script clásico) sí es global; su const EST_VIS NO
  // (const/let no se cuelgan de window) → no referenciar EST_VIS desde este módulo.
  const est = isEstimated(p);
  if (!est && vis < MIN_DRAW) return null;
  return {
    v: new THREE.Vector3(p[0], -p[1], -p[2]),   // invertir Y (y Z para mano derecha)
    dim: est || vis < DIM_VIS,
  };
}

const _up = new THREE.Vector3(0, 1, 0);
function placeBone(mesh, a, b) {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const d = b.clone().sub(a);
  mesh.position.copy(mid);
  mesh.scale.set(1, d.length(), 1);
  mesh.quaternion.setFromUnitVectors(_up, d.normalize());
}

function showFrame(f) {
  state.frame = Math.max(0, Math.min(f, (state.world?.length || 1) - 1));
  els.slider.value = state.frame;
  els.frameLabel.textContent = `${state.frame} / ${(state.world?.length || 1) - 1}`;
  for (const i of CORE_JOINTS) {
    const p = ptOf(state.frame, i);
    joints[i].visible = !!p;
    if (p) {
      joints[i].position.copy(p.v);
      joints[i].material = (p.dim ? jointMatDim : jointMat)[sideOf(i)];
    }
  }
  BONES3D.forEach(([a, b], k) => {
    const pa = ptOf(state.frame, a), pb = ptOf(state.frame, b);
    bones[k].visible = !!(pa && pb);
    if (pa && pb) {
      placeBone(bones[k], pa.v, pb.v);
      bones[k].material = (pa.dim || pb.dim ? jointMatDim : jointMat)[bones[k].userData.side];
    }
  });
  // cabeza: punto medio de orejas (7,8), fallback nariz (0); cuello a medio-hombros
  const e1 = ptOf(state.frame, 7), e2 = ptOf(state.frame, 8), nose = ptOf(state.frame, 0);
  const head = (e1 && e2)
    ? { v: e1.v.clone().add(e2.v).multiplyScalar(0.5), dim: e1.dim || e2.dim }
    : (nose || null);
  const s1 = ptOf(state.frame, 11), s2 = ptOf(state.frame, 12);
  headMesh.visible = !!head;
  if (head) {
    headMesh.position.copy(head.v);
    headMesh.material = (head.dim ? jointMatDim : jointMat).mid;
  }
  const canNeck = !!(head && s1 && s2);
  neckBone.visible = canNeck;
  if (canNeck) {
    const shMid = s1.v.clone().add(s2.v).multiplyScalar(0.5);
    placeBone(neckBone, shMid, head.v);
    neckBone.material = (head.dim || s1.dim || s2.dim ? jointMatDim : jointMat).mid;
  }
}

// Altura del suelo: percentil 5 de la Y de los tobillos en todo el video
// (robusto a frames sin pose / outliers).
function computeGroundY() {
  const ys = [];
  for (let f = 0; f < (state.world?.length || 0); f++) {
    for (const i of [27, 28]) {
      const p = ptOf(f, i);
      if (p) ys.push(p.v.y);
    }
  }
  if (!ys.length) return -1;
  ys.sort((a, b) => a - b);
  return ys[Math.floor(ys.length * 0.05)];
}

// ── Carga ─────────────────────────────────────────────────────────────────────
async function loadVideo(video) {
  pause();
  state.video = video;
  els.videoSelect.value = video;
  els.status.textContent = "cargando vectores 3D…";
  try {
    const meta = await (await fetch(`/api/meta/${encodeURIComponent(video)}`)).json();
    state.fps = meta.fps || 30;
    state.rawWorld = await loadLandmarks(video, {
      world: true, smooth: els.smoothToggle.checked,
      onWait: () => { els.status.textContent = "procesando pose… (puede tardar minutos la 1ª vez)"; },
    });
    els.status.textContent = renderer
      ? "" : "este navegador no soporta WebGL (no se puede renderizar 3D)";
    applyFill();
    els.slider.max = state.world.length - 1;
    showFrame(0);
  } catch (err) {
    els.status.textContent = "error: " + err.message;
  }
}

// Rachas no confiables que tocan el inicio/fin del video no tienen ancla de un
// lado → fillOcclusions no puede interpolar. Para el VIEWER (solo visual, no
// métricas): sostener el primer/último valor confiable, marcado como estimado
// (vis=2) para que se dibuje translúcido. Ej.: profesor_carving pierde codo y
// muñeca derechos en f0-f57 porque el brazo arranca ocluido desde f0.
function holdEdges(lm) {
  const F = lm.length;
  const out = lm.map((fr) => fr.map((p) => (p ? p.slice() : p)));
  const ok = (p) => p && p[0] != null && (isEstimated(p) || p[3] >= 0.5);
  for (let i = 0; i < 33; i++) {
    let first = -1, last = -1;
    for (let f = 0; f < F; f++) {
      if (ok(lm[f][i])) { if (first < 0) first = f; last = f; }
    }
    if (first < 0) continue;   // el joint nunca fue confiable: no inventar
    for (let f = 0; f < first; f++)
      out[f][i] = [lm[first][i][0], lm[first][i][1], lm[first][i][2], 2];
    for (let f = last + 1; f < F; f++)
      out[f][i] = [lm[last][i][0], lm[last][i][1], lm[last][i][2], 2];
  }
  return out;
}

// Aplica (o no) el relleno temporal de oclusiones sobre el world crudo, y
// recalcula suelo + target de cámara. fillOcclusions (occlusion.js) interpola
// x, y y z → funciona igual sobre coords en metros.
function applyFill() {
  if (!state.rawWorld) return;
  // maxGap 120 (~4s a 30fps): más laxo que el default 45 de las vistas 2D porque
  // aquí es solo visual (translúcido) — en 2D el relleno alimenta métricas.
  state.world = els.fillToggle.checked
    ? holdEdges(fillOcclusions(state.rawWorld, null, 0.5, 120))
    : state.rawWorld;
  state.groundY = computeGroundY();
  grid.position.y = state.groundY;
  if (controls) controls.target.set(0, (state.groundY + 0.9) / 2 - 0.45, 0);
}

// ── Playback ──────────────────────────────────────────────────────────────────
let _lastTick = 0;
function pause() {
  state.playing = false;
  els.playBtn.textContent = "▶ play";
}
function togglePlay() {
  if (!state.world) return;
  state.playing = !state.playing;
  els.playBtn.textContent = state.playing ? "⏸ pausa" : "▶ play";
  _lastTick = performance.now();
}

function animate(now) {
  requestAnimationFrame(animate);
  if (state.playing && state.world) {
    const dt = now - _lastTick;
    const step = Math.floor(dt / (1000 / state.fps));
    if (step > 0) {
      _lastTick = now;
      const next = state.frame + step;
      showFrame(next >= state.world.length ? 0 : next);   // loop
    }
  }
  if (controls) controls.update();
  if (renderer) renderer.render(scene, camera);
}

function fitStage() {
  if (!renderer) return;
  const w = els.stage.clientWidth, h = els.stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", fitStage);

// ── Listeners ─────────────────────────────────────────────────────────────────
els.videoSelect.addEventListener("change", (e) => loadVideo(e.target.value));
els.smoothToggle.addEventListener("change", () => state.video && loadVideo(state.video));
els.fillToggle.addEventListener("change", () => {   // re-procesa en memoria, sin re-fetch
  applyFill();
  showFrame(state.frame);
});
els.playBtn.addEventListener("click", togglePlay);
els.prevBtn.addEventListener("click", () => { pause(); showFrame(state.frame - 1); });
els.nextBtn.addEventListener("click", () => { pause(); showFrame(state.frame + 1); });
els.slider.addEventListener("input", (e) => { pause(); showFrame(+e.target.value); });
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (e.key === "ArrowLeft") { pause(); showFrame(state.frame - 1); }
  if (e.key === "ArrowRight") { pause(); showFrame(state.frame + 1); }
  if (e.key === " ") { e.preventDefault(); togglePlay(); }
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  fitStage();
  animate(performance.now());
  const { videos } = await (await fetch("/api/videos")).json();
  const lib = await loadLibrary();
  populateVideoSelect(els.videoSelect, videos, lib);
  if (videos.length) await loadVideo(videos[0]);
}
init();
