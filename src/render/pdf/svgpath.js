/**
 * SVG path data to PDF path operators.
 *
 * Enough of the SVG grammar for the brand's vectorised marks: absolute and
 * relative M, L, H, V, C and Z, with implicit repeats. The result is a string of
 * `m`, `l`, `c` and `h` operators in PDF user space, with the y axis flipped so
 * a path authored top-down draws the right way up on the page.
 */
export function svgPathToPdf(d, { x = 0, y = 0, scale = 1, viewBox = [0, 0, 100, 100] } = {}) {
  const [vx, vy, , vh] = viewBox;
  const tx = (px) => x + (px - vx) * scale;
  const ty = (py) => y + (vh - (py - vy)) * scale;
  const tokens = String(d).match(/[MmLlHhVvCcZz]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  const out = [];
  let cmd = null; let cx = 0; let cy = 0; let sx = 0; let sy = 0;
  let i = 0;
  const num = () => Number(tokens[i++]);
  const f = (v) => v.toFixed(2);
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[MmLlHhVvCcZz]$/.test(t)) { cmd = t; i += 1; if (cmd === 'Z' || cmd === 'z') { out.push('h'); cx = sx; cy = sy; continue; } }
    if (cmd == null) { i += 1; continue; }
    switch (cmd) {
      case 'M': cx = num(); cy = num(); sx = cx; sy = cy; out.push(`${f(tx(cx))} ${f(ty(cy))} m`); cmd = 'L'; break;
      case 'm': cx += num(); cy += num(); sx = cx; sy = cy; out.push(`${f(tx(cx))} ${f(ty(cy))} m`); cmd = 'l'; break;
      case 'L': cx = num(); cy = num(); out.push(`${f(tx(cx))} ${f(ty(cy))} l`); break;
      case 'l': cx += num(); cy += num(); out.push(`${f(tx(cx))} ${f(ty(cy))} l`); break;
      case 'H': cx = num(); out.push(`${f(tx(cx))} ${f(ty(cy))} l`); break;
      case 'h': cx += num(); out.push(`${f(tx(cx))} ${f(ty(cy))} l`); break;
      case 'V': cy = num(); out.push(`${f(tx(cx))} ${f(ty(cy))} l`); break;
      case 'v': cy += num(); out.push(`${f(tx(cx))} ${f(ty(cy))} l`); break;
      case 'C': {
        const x1 = num(); const y1 = num(); const x2 = num(); const y2 = num(); cx = num(); cy = num();
        out.push(`${f(tx(x1))} ${f(ty(y1))} ${f(tx(x2))} ${f(ty(y2))} ${f(tx(cx))} ${f(ty(cy))} c`); break;
      }
      case 'c': {
        const x1 = cx + num(); const y1 = cy + num(); const x2 = cx + num(); const y2 = cy + num(); cx += num(); cy += num();
        out.push(`${f(tx(x1))} ${f(ty(y1))} ${f(tx(x2))} ${f(ty(y2))} ${f(tx(cx))} ${f(ty(cy))} c`); break;
      }
      default: i += 1;
    }
  }
  return out.join(' ');
}
