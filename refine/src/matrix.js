// 2D affine matrices [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f
export const I = [1, 0, 0, 1, 0, 0];
export const mult = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
export const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
export const isIdentity = (m) => Math.abs(m[0] - 1) < 1e-12 && Math.abs(m[1]) < 1e-12 && Math.abs(m[2]) < 1e-12 && Math.abs(m[3] - 1) < 1e-12 && Math.abs(m[4]) < 1e-12 && Math.abs(m[5]) < 1e-12;
export const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
// uniform scale (+ rotation/reflection): circles stay circles, strokes keep their width ratio
export const isUniform = (m) => Math.abs(Math.hypot(m[0], m[1]) - Math.hypot(m[2], m[3])) < 1e-9 * Math.max(1, Math.hypot(m[0], m[1])) && Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-9 * Math.max(1, m[0] * m[0] + m[1] * m[1]);
export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
// Strict SVG transform-list grammar. Browsers ignore the WHOLE attribute when any part
// is invalid (unknown function, wrong argument count, stray text), so a partial parse
// would draw something no browser draws. Returns null for an invalid list (the caller
// then uses no transform, like a browser, and protects the element).
const ARGS = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1] };
const NUM = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
export function parseTransform(s) {
  let m = I.slice();
  if (s == null) return m;
  const src = String(s).trim();
  if (!src || src === 'none') return m;
  const re = /\s*([A-Za-z]+)\s*\(([^()]*)\)\s*,?/y;
  let x, pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    if (!(x = re.exec(src))) return null;
    pos = re.lastIndex;
    const fn = x[1], counts = ARGS[fn];
    if (!counts) return null;
    const parts = x[2].trim() === '' ? [] : x[2].trim().split(/\s*,\s*|\s+/);
    if (!parts.every((p) => NUM.test(p)) || !counts.includes(parts.length)) return null;
    const a = parts.map(Number);
    let t;
    switch (fn) {
      case 'matrix': t = a; break;
      case 'translate': t = [1, 0, 0, 1, a[0], a[1] ?? 0]; break;
      case 'scale': t = [a[0], 0, 0, a[1] ?? a[0], 0, 0]; break;
      case 'rotate': {
        const r = (a[0] * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
        t = [c, sn, -sn, c, 0, 0];
        if (a.length === 3) t = mult(mult([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]);
        break;
      }
      case 'skewX': t = [1, 0, Math.tan((a[0] * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan((a[0] * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mult(m, t);
  }
  return m;
}
export const fmtMatrix = (m, f) => `matrix(${m.map(f).join(' ')})`;
