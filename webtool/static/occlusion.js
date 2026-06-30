// occlusion.js — relleno temporal de landmarks ocluidos (compartido por las 3 vistas).
//
// Problema: en plano lateral, el miembro del lado de atrás se ocluye y MediaPipe lo
// "adivina" con visibility baja (o no lo da). Si la articulación SÍ se ve antes y después
// de la oclusión, podemos estimar su posición en el medio interpolando linealmente entre
// los dos frames confiables que la rodean.
//
// Funciones puras (sin DOM). Cargar ANTES de app.js / pane.js / sequence.js.

// Marca de visibility para puntos ESTIMADOS (rellenados). Fuera de [0,1] a propósito:
// así se distinguen al dibujar (color aparte) y NO se filtran por el umbral de baja
// visibility en las métricas (se consideran usables, son nuestra mejor estimación).
const EST_VIS = 2;

function isEstimated(p) { return p != null && p[3] === EST_VIS; }

// Rellena oclusiones cortas. Por cada joint, los frames no-confiables (visibility < minVis
// o sin punto) que estén BRACKETEADOS por frames confiables a ambos lados, y cuya racha no
// supere maxGap frames, se interpolan linealmente entre los dos confiables.
//
// `corrections` (opcional) = {frame: {jointIdx: [normX, normY]}} (correcciones manuales).
// Un frame corregido cuenta como CONFIABLE y como ANCLA: el relleno se re-interpola a
// través de él → corregís un frame y la racha ocluida vecina se reacomoda. La posición
// corregida se "hornea" en el array (vis=1) para que se vea en todas las vistas.
//
// Devuelve un NUEVO array [F,33,4]; los rellenados llevan vis = EST_VIS. Rachas en los
// extremos (sin anclaje de un lado) o demasiado largas se dejan tal cual.
function fillOcclusions(lm, corrections, minVis = 0.5, maxGap = 45) {
  if (!lm || !lm.length) return lm;
  const F = lm.length, J = 33;
  const corr = corrections || {};
  const out = lm.map((fr) => fr.map((p) => (p ? p.slice() : p)));
  const corrAt = (f, i) => (corr[f] && corr[f][i]) ? corr[f][i] : null;
  const rawZ = (f, i) => (lm[f][i] && lm[f][i][2] != null) ? lm[f][i][2] : 0;
  const reliable = (f, i) => {
    if (corrAt(f, i)) return true;
    const p = lm[f][i];
    return p && p[0] != null && p[1] != null && p[3] != null && p[3] >= minVis;
  };
  const anchor = (f, i) => {
    const c = corrAt(f, i);
    if (c) return [c[0], c[1], rawZ(f, i)];
    const p = lm[f][i];
    return [p[0], p[1], p[2]];
  };
  for (let i = 0; i < J; i++) {
    // hornear las correcciones como puntos confiables (vis=1)
    for (let f = 0; f < F; f++) {
      const c = corrAt(f, i);
      if (c) out[f][i] = [c[0], c[1], rawZ(f, i), 1];
    }
    let f = 0;
    while (f < F) {
      if (reliable(f, i)) { f++; continue; }
      const a = f;                       // inicio de la racha no-confiable
      let b = a;
      while (b < F && !reliable(b, i)) b++;   // b = primer confiable después (o F)
      const left = a - 1, right = b;
      if (left >= 0 && right < F && (b - a) <= maxGap) {
        const pl = anchor(left, i), pr = anchor(right, i);
        for (let k = a; k < b; k++) {
          const t = (k - left) / (right - left);
          out[k][i] = [
            pl[0] + (pr[0] - pl[0]) * t,
            pl[1] + (pr[1] - pl[1]) * t,
            pl[2] + (pr[2] - pl[2]) * t,
            EST_VIS,
          ];
        }
      }
      f = b;
    }
  }
  return out;
}
