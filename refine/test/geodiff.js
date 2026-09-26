// Geometric comparison of two drawings (independent of the engine's own checks):
// every drawn contour sampled densely in root coordinates, then the symmetric
// Hausdorff distance between the two point sets, in artwork units (1 u = 1/1000 of the
// larger viewBox side). Also: element / contour counts and per-element topology, and the
// same distance per paint (fill and stroke colour), so a shape drawn in the wrong colour
// counts as far from its place.
import { loadSVG } from '../src/model.js';
import { expand } from '../src/pathdata.js';
import { flatten } from '../src/geom.js';
import { apply } from '../src/matrix.js';
import { topology } from '../src/features.js';

export function drawing(text) {
  const doc = loadSVG(text);
  const size = Math.max(doc.viewBox[2], doc.viewBox[3]), u = size / 1000;
  const els = doc.elements.filter((e) => e.subpaths && e.subpaths.length);
  const pts = [], byPaint = new Map();
  const paint = (p) => (p && p.kind === 'solid' ? p.rgb.slice(0, 3).join(',') : p ? p.kind : 'none');
  for (const e of els) {
    const key = `fill ${paint(e.fill)} / stroke ${paint(e.stroke)}`;
    if (!byPaint.has(key)) byPaint.set(key, []);
    const mine = byPaint.get(key);
    for (const sp of e.subpaths) {
      const P = [...flatten(expand(sp.segs), 0.002 * u), sp.segs.length ? sp.segs.at(-1).p.at(-1) : sp.start];
      // dense: every 0.05 u along the flattened outline
      for (let i = 0; i + 1 < P.length; i++) {
        const a = apply(e.ctm, P[i]), b = apply(e.ctm, P[i + 1]), n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (0.05 * u)));
        for (let t = 0; t < n; t++) { const q = [a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n]; pts.push(q); mine.push(q); }
      }
    }
  }
  return { doc, u, pts, byPaint, elements: els.length, contours: els.reduce((n, e) => n + e.subpaths.length, 0), topo: els.map((e) => topology(e.subpaths, e.rule, u).signature).join(' | ') };
}
function directed(A, B, cell) {
  const grid = new Map(), key = (x, y) => `${x},${y}`;
  for (const q of B) { const k = key(Math.floor(q[0] / cell), Math.floor(q[1] / cell)); (grid.get(k) || grid.set(k, []).get(k)).push(q); }
  let worst = 0;
  for (const p of A) {
    const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
    let best = Infinity;
    for (let r = 1; best === Infinity && r < 64; r *= 2) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) { const l = grid.get(key(gx + dx, gy + dy)); if (l) for (const q of l) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1])); }
    worst = Math.max(worst, best);
  }
  return worst;
}
// symmetric Hausdorff distance in artwork units (u)
export function geoDistance(a, b) {
  const cell = 2 * a.u;
  if (!a.pts.length || !b.pts.length) return a.pts.length === b.pts.length ? 0 : Infinity;
  return Math.max(directed(a.pts, b.pts, cell), directed(b.pts, a.pts, cell)) / a.u;
}
// the same, paint by paint (the largest); a paint present on one side only: Infinity
export function paintDistance(a, b) {
  let worst = 0;
  for (const k of new Set([...a.byPaint.keys(), ...b.byPaint.keys()])) {
    const A = a.byPaint.get(k) || [], B = b.byPaint.get(k) || [];
    if (!A.length || !B.length) { if (A.length !== B.length) return Infinity; continue; }
    worst = Math.max(worst, Math.max(directed(A, B, 2 * a.u), directed(B, A, 2 * a.u)) / a.u);
  }
  return worst;
}
