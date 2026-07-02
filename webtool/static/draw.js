// draw.js — render compartido de anotaciones (lápiz / flecha / texto) sobre canvas.
// Lo usan las 3 vistas (pane.js, app.js, sequence.js) y el export PNG, para que un
// mismo item se vea igual en todos lados. Items en coordenadas normalizadas 0-1:
//   { tool:"pen",   stroke:[[x,y],...], color }   (datos viejos: sin tool, solo stroke)
//   { tool:"arrow", from:[x,y], to:[x,y], color }
//   { tool:"text",  pos:[x,y], text, color }
// Grosores y fuente escalan con la altura del canvas (pane a resolución nativa,
// celdas de secuencia pequeñas, export PNG).

const ANNOT_COLOR = "#f33";

function annotLineWidth(H) { return Math.max(2, H * 0.004); }
function annotFontPx(H) { return Math.max(11, Math.round(H * 0.032)); }

function drawArrowShape(ctx, x1, y1, x2, y2, color, lw) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(9, lw * 3.5);
  ctx.strokeStyle = color; ctx.fillStyle = color;
  ctx.lineWidth = lw; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45));
  ctx.lineTo(x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45));
  ctx.closePath(); ctx.fill();
}

function drawAnnotationItems(ctx, items, W, H) {
  if (!items || !items.length) return;
  const lw = annotLineWidth(H);
  for (const s of items) {
    const color = s.color || ANNOT_COLOR;
    if (s.tool === "text" && s.text) {
      const fs = annotFontPx(H);
      const x = s.pos[0] * W, y = s.pos[1] * H;
      ctx.font = `bold ${fs}px sans-serif`;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      // halo oscuro: legible tanto sobre video como sobre fondo claro
      ctx.lineWidth = Math.max(2, fs / 6); ctx.strokeStyle = "rgba(0,0,0,.6)";
      ctx.strokeText(s.text, x, y);
      ctx.fillStyle = color; ctx.fillText(s.text, x, y);
      ctx.textBaseline = "alphabetic";
    } else if (s.tool === "arrow" && s.from && s.to) {
      drawArrowShape(ctx, s.from[0] * W, s.from[1] * H,
                     s.to[0] * W, s.to[1] * H, color, lw * 1.2);
    } else if (s.stroke && s.stroke.length) {
      ctx.strokeStyle = color; ctx.lineWidth = lw * 1.2; ctx.lineCap = "round";
      ctx.beginPath();
      s.stroke.forEach((p, i) => {
        const x = p[0] * W, y = p[1] * H;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }
}

// Input flotante para la herramienta de texto. Se monta en containerEl
// (position:relative) en coords CSS del contenedor. Enter o click fuera confirma
// → onCommit(texto); Escape cancela.
function spawnTextInput(containerEl, cssX, cssY, onCommit) {
  const prev = containerEl.querySelector(".annotTextInput");
  if (prev) prev.remove();
  const input = document.createElement("input");
  input.className = "annotTextInput";
  input.placeholder = "texto…";
  input.style.left = Math.round(cssX) + "px";
  input.style.top = Math.round(cssY) + "px";
  containerEl.appendChild(input);
  input.focus();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const t = input.value.trim();
    input.remove();
    if (commit && t) onCommit(t);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
    e.stopPropagation();   // que no dispare atajos de la vista (espacio, flechas)
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("mousedown", (e) => e.stopPropagation());
}
