// Gradients, drawn per pixel as a browser draws them: linear and radial (focal point
// and fr), stops with stop-opacity, gradientUnits, gradientTransform, spreadMethod
// (pad / reflect / repeat), attributes and stops inherited through href.
// Anything that cannot be resolved exactly sets `unknown` (the element is then locked).
import { getAttr, localName } from './xml.js';
import { declared, parseColor } from './css.js';
import { parseTransform, mult, invert, apply } from './matrix.js';

const ATTRS = { linearGradient: ['x1', 'y1', 'x2', 'y2'], radialGradient: ['cx', 'cy', 'r', 'fx', 'fy', 'fr'] };
const COMMON = ['gradientUnits', 'gradientTransform', 'spreadMethod', 'color-interpolation'];
const hrefOf = (n) => getAttr(n, 'href') ?? getAttr(n, 'xlink:href');

export function resolveGradient(el, doc) {
  const type = localName(el.name) === 'radialGradient' ? 'radial' : 'linear';
  const own = ATTRS[type === 'radial' ? 'radialGradient' : 'linearGradient'];
  const got = {};
  let stops = null, unknown = null;
  const seen = new Set();
  for (let g = el; g && !seen.has(g); ) {
    seen.add(g);
    const gt = localName(g.name);
    for (const k of COMMON) if (got[k] == null && getAttr(g, k) != null) got[k] = getAttr(g, k);
    if (gt === localName(el.name)) for (const k of own) if (got[k] == null && getAttr(g, k) != null) got[k] = getAttr(g, k);
    const st = g.children.filter((c) => c.type === 'el' && localName(c.name) === 'stop');
    if (!stops && st.length) stops = st;
    const h = hrefOf(g);
    if (!h) break;
    const next = doc.ids.get(h.replace(/^#/, ''));
    if (!next || !/Gradient$/.test(localName(next.name))) { if (h) unknown = unknown || 'gradient href does not point to a gradient'; break; }
    g = next;
  }
  const units = got.gradientUnits === 'userSpaceOnUse' ? 'userSpaceOnUse' : 'objectBoundingBox';
  const tf = got.gradientTransform != null ? parseTransform(got.gradientTransform) : [1, 0, 0, 1, 0, 0];
  if (!tf) unknown = unknown || 'unreadable gradientTransform';
  if ((got['color-interpolation'] || '').trim() === 'linearRGB') unknown = unknown || 'color-interpolation linearRGB';
  // lengths: bbox units take fractions or percentages; user units take numbers
  const L = (k, d) => {
    const v = got[k];
    if (v == null) return d;
    const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(%|px)?\s*$/.exec(v);
    if (!m) { unknown = unknown || `gradient ${k}="${v}" is not understood`; return d; }
    if (m[2] === '%') { if (units === 'userSpaceOnUse') { unknown = unknown || `percentage ${k} in user space`; return d; } return +m[1] / 100; }
    return +m[1];
  };
  const out = { type, units, tf: tf || [1, 0, 0, 1, 0, 0], spread: ['reflect', 'repeat'].includes(got.spreadMethod) ? got.spreadMethod : 'pad', stops: [], unknown: null };
  if (type === 'linear') Object.assign(out, { x1: L('x1', 0), y1: L('y1', 0), x2: L('x2', units === 'userSpaceOnUse' ? NaN : 1), y2: L('y2', 0) });
  else {
    const cx = L('cx', 0.5), cy = L('cy', 0.5), r = L('r', 0.5);
    Object.assign(out, { cx, cy, r, fx: got.fx != null ? L('fx', cx) : cx, fy: got.fy != null ? L('fy', cy) : cy, fr: L('fr', 0) });
    if (units === 'userSpaceOnUse' && [got.cx, got.cy, got.r].some((v) => v == null)) unknown = unknown || 'user-space radial gradient without cx / cy / r (percent defaults)';
    if (out.r < 0 || out.fr < 0) unknown = unknown || 'negative radius';
    if (Math.hypot(out.fx - cx, out.fy - cy) > r - out.fr + 1e-9) unknown = unknown || 'focal circle outside the gradient circle';
  }
  if (type === 'linear' && units === 'userSpaceOnUse' && got.x2 == null) unknown = unknown || 'user-space linear gradient without x2 (100 % of the viewport)';
  let prev = 0;
  for (const s of stops || []) {
    const d = declared(s, doc.rules);
    let o = getAttr(s, 'offset') ?? '0';
    const om = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(%)?\s*$/.exec(o);
    if (!om) { unknown = unknown || `stop offset "${o}"`; continue; }
    let off = om[2] ? +om[1] / 100 : +om[1];
    off = Math.max(prev, Math.min(1, Math.max(0, off)));
    prev = off;
    const cv = (d['stop-color'] ?? 'black').trim();
    const c = parseColor(cv);
    if (!c || /currentcolor|inherit|var\(/i.test(cv)) { unknown = unknown || `stop-color "${cv}"`; continue; }
    const so = parseFloat(d['stop-opacity'] ?? '1');
    out.stops.push({ o: off, c: [c[0], c[1], c[2], c[3] * (isFinite(so) ? Math.max(0, Math.min(1, so)) : 1)] });
  }
  out.unknown = unknown;
  return out;
}

// colour [r,g,b,a] at gradient parameter t
function colorAt(g, t) {
  const S = g.stops;
  if (g.spread === 'repeat') t = t - Math.floor(t);
  else if (g.spread === 'reflect') { t = Math.abs(t) % 2; if (t > 1) t = 2 - t; }
  if (t <= S[0].o) return S[0].c;
  if (t >= S[S.length - 1].o) return S[S.length - 1].c;
  let i = 1;
  while (i < S.length && S[i].o < t) i++;
  const a = S[i - 1], b = S[i], f = b.o > a.o ? (t - a.o) / (b.o - a.o) : 1;
  // interpolated per channel without premultiplying (as Chrome / Skia do for SVG)
  return [a.c[0] + (b.c[0] - a.c[0]) * f, a.c[1] + (b.c[1] - a.c[1]) * f, a.c[2] + (b.c[2] - a.c[2]) * f, a.c[3] + (b.c[3] - a.c[3]) * f];
}
// gradient parameter at a point of gradient space; null where nothing is painted
function paramAt(g, x, y) {
  if (g.type === 'linear') {
    const dx = g.x2 - g.x1, dy = g.y2 - g.y1, L2 = dx * dx + dy * dy;
    if (!(L2 > 0)) return 1;                                  // zero-length vector: the last stop
    return ((x - g.x1) * dx + (y - g.y1) * dy) / L2;
  }
  // radial: largest t with |p - c(t)| = r(t), r(t) >= 0; c(t) = f + t (c - f), r(t) = fr + t (r - fr)
  const cdx = g.cx - g.fx, cdy = g.cy - g.fy, dr = g.r - g.fr, pdx = x - g.fx, pdy = y - g.fy;
  const a = cdx * cdx + cdy * cdy - dr * dr, b = pdx * cdx + pdy * cdy + g.fr * dr, c = pdx * pdx + pdy * pdy - g.fr * g.fr;
  if (!(g.r > 0)) return 1;
  if (Math.abs(a) < 1e-12) { if (Math.abs(b) < 1e-12) return null; const t = c / (2 * b); return g.fr + t * dr >= 0 ? t : null; }
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc), t1 = (b + s) / a, t2 = (b - s) / a, t = Math.max(t1, t2);
  if (g.fr + t * dr >= 0) return t;
  const tm = Math.min(t1, t2);
  return g.fr + tm * dr >= 0 ? tm : null;
}
// bbox (local coordinates, geometry only) of subpaths
export function geomBox(subpaths, flattenFn) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sp of subpaths) for (const p of [...flattenFn(sp), ...(sp.segs.length ? [sp.segs[sp.segs.length - 1].p.at(-1)] : [])]) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  return [x0, y0, x1, y1];
}
// Per-pixel RGBA of a gradient over a coverage box. m: element CTM, bb: its geometry box.
// Returns null when the gradient paints nothing (a zero-size box with bbox units).
export function gradientPixels(g, box, view, m, bb) {
  let G = g.tf;
  if (g.units === 'objectBoundingBox') {
    const w = bb[2] - bb[0], h = bb[3] - bb[1];
    if (!(w > 0 && h > 0)) return null;
    G = mult([w, 0, 0, h, bb[0], bb[1]], g.tf);
  }
  // pixel -> gradient space
  const toUser = invert(mult(m, G));
  if (!toUser) return null;
  const col = new Float32Array(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
    const i = y * box.w + x;
    if (!box.data[i]) continue;
    const q = apply(toUser, [view.x + (box.x0 + x + 0.5) / view.k, view.y + (box.y0 + y + 0.5) / view.k]);
    const t = paramAt(g, q[0], q[1]);
    const c = t == null ? [0, 0, 0, 0] : colorAt(g, t);
    col[i * 4] = c[0]; col[i * 4 + 1] = c[1]; col[i * 4 + 2] = c[2]; col[i * 4 + 3] = c[3];
  }
  return col;
}
