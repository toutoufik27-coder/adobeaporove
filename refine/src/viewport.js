// Viewports: width / height with units, viewBox and preserveAspectRatio (9 alignments x
// meet / slice, or none), mapped exactly as a browser maps them.
import { getAttr } from './xml.js';

const UNIT = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 96 / 72, pc: 16, em: 16, ex: 8, q: 96 / 101.6 };
// A length in user units; `ref` resolves percentages (null: percentages are unknown).
export function parseLength(v, ref = null) {
  if (v == null) return null;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)\s*$/.exec(String(v));
  if (!m) return null;
  const n = +m[1], u = m[2].toLowerCase();
  if (!u) return n;
  if (u === '%') return ref == null ? null : (n / 100) * ref;
  return u in UNIT ? n * UNIT[u] : null;
}
export function parsePAR(s) {
  const t = String(s || '').trim().split(/\s+/).filter((x) => x && x !== 'defer');
  const align = t[0] || 'xMidYMid', mode = t[1] || 'meet';
  if (align === 'none') return { none: true, ax: 0, ay: 0, slice: false };
  const m = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.exec(align);
  if (!m || (mode !== 'meet' && mode !== 'slice')) return null;              // invalid: browsers use the default
  const f = { Min: 0, Mid: 0.5, Max: 1 };
  return { none: false, ax: f[m[1]], ay: f[m[2]], slice: mode === 'slice' };
}
// user space (viewBox) -> viewport [a b c d e f] for a viewport of w x h
export function viewBoxTransform(vb, w, h, par) {
  const p = par || parsePAR('');
  const [x, y, vw, vh] = vb;
  let sx = w / vw, sy = h / vh;
  if (p.none) return [sx, 0, 0, sy, -x * sx, -y * sy];
  const s = p.slice ? Math.max(sx, sy) : Math.min(sx, sy);
  const tx = (w - vw * s) * p.ax - x * s, ty = (h - vh * s) * p.ay - y * s;
  return [s, 0, 0, s, tx, ty];
}
// The root's intrinsic size and viewBox mapping.
export function rootViewport(doc) {
  const r = doc.root, vb = doc.viewBox;
  const w = parseLength(getAttr(r, 'width')), h = parseLength(getAttr(r, 'height'));
  const W = w > 0 ? w : (h > 0 && vb ? (h * vb[2]) / vb[3] : vb[2]), H = h > 0 ? h : (w > 0 && vb ? (w * vb[3]) / vb[2] : vb[3]);
  return { W, H, par: parsePAR(getAttr(r, 'preserveAspectRatio')) || parsePAR(''), hasViewBox: !!getAttr(r, 'viewBox') };
}
// The render view that shows exactly what a browser shows in a viewport of the SVG's
// own aspect, `side` pixels on its longer side: the visible user-space rectangle
// (larger than the viewBox with "meet" and another aspect, smaller with "slice").
// cssW / cssH: the <img> size that gives the browser render the same pixel grid.
// preserveAspectRatio="none" scales non-uniformly; the internal view stays uniform
// (the viewBox at its own aspect), and cssW / cssH follow it.
export function renderViewFor(doc, side = 700) {
  const vp = rootViewport(doc), vb = doc.viewBox;
  if (!vp.hasViewBox) {
    const k = side / Math.max(vp.W, vp.H), W = Math.max(1, Math.round(vp.W * k)), H = Math.max(1, Math.round(vp.H * k));
    return { view: { x: 0, y: 0, k, W, H }, cssW: W, cssH: H, par: vp.par };
  }
  const aspectW = vp.par.none ? vb[2] : vp.W, aspectH = vp.par.none ? vb[3] : vp.H;
  const s = side / Math.max(aspectW, aspectH);
  const W = Math.max(1, Math.round(aspectW * s)), H = Math.max(1, Math.round(aspectH * s));
  const m = viewBoxTransform(vb, W, H, vp.par.none ? parsePAR('') : vp.par);
  return { view: { x: -m[4] / m[0], y: -m[5] / m[3], k: m[0], W, H }, cssW: W, cssH: H, par: vp.par };
}
