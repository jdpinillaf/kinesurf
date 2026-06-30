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
// supere maxGap frames, se interpolan linealmente entre los dos confiables. Devuelve un
// NUEVO array [F,33,4]; los puntos rellenados llevan vis = EST_VIS. Las rachas en los
// extremos (sin anclaje de un lado) o demasiado largas se dejan tal cual.
function fillOcclusions(lm, minVis = 0.5, maxGap = 45) {
  if (!lm || !lm.length) return lm;
  const F = lm.length, J = 33;
  const out = lm.map((fr) => fr.map((p) => (p ? p.slice() : p)));
  const reliable = (f, i) => {
    const p = lm[f][i];
    return p && p[0] != null && p[1] != null && p[3] != null && p[3] >= minVis;
  };
  for (let i = 0; i < J; i++) {
    let f = 0;
    while (f < F) {
      if (reliable(f, i)) { f++; continue; }
      const a = f;                       // inicio de la racha no-confiable
      let b = a;
      while (b < F && !reliable(b, i)) b++;   // b = primer confiable después (o F)
      const left = a - 1, right = b;
      if (left >= 0 && right < F && (b - a) <= maxGap) {
        const pl = lm[left][i], pr = lm[right][i];
        for (let k = a; k < b; k++) {
          const t = (k - left) / (right - left);
          const x = pl[0] + (pr[0] - pl[0]) * t;
          const y = pl[1] + (pr[1] - pl[1]) * t;
          const z = (pl[2] != null && pr[2] != null) ? pl[2] + (pr[2] - pl[2]) * t : 0;
          out[k][i] = [x, y, z, EST_VIS];
        }
      }
      f = b;
    }
  }
  return out;
}
