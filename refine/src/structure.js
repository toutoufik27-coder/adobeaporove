// Structure perception: repeated marks (same shape, same element) and how they are
// arranged — around a centre (clock ticks, dots on a ring, snowflake tips) or on a
// line (buttons, windows). Counting and spacing are measured here, exactly; a model
// is only asked what the object should have.
import { sampleNative, topology } from './features.js';
import { fitCircle, polyArea, bbox, dist } from './geom.js';
import { apply } from './matrix.js';

export function markInfo(e, sp, u) {
  const P = sampleNative(sp, Math.max(0.2 * u, 1e-6)).pts.map((q) => apply(e.ctm, q));
  if (P.length < 3) return null;
  let A = 0, cx = 0, cy = 0;
  for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length], c = p[0] * q[1] - q[0] * p[1]; A += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c; }
  if (Math.abs(A) < 1e-12) return null;
  cx /= 3 * A; cy /= 3 * A; A = Math.abs(A) / 2;
  // principal axes (second moments of the outline points)
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of P) { const dx = p[0] - cx, dy = p[1] - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const n = P.length, a = sxx / n, b = syy / n, c = sxy / n, t = (a + b) / 2, d = Math.sqrt(((a - b) / 2) ** 2 + c * c);
  const l1 = t + d, l2 = Math.max(1e-12, t - d), theta = 0.5 * Math.atan2(2 * c, a - b);
  const bb = bbox(P);
  return { cx, cy, area: A, elong: Math.sqrt(l1 / l2), axis: theta, size: Math.max(bb[2] - bb[0], bb[3] - bb[1]) };
}

export function findGroups(doc, u) {
  const size = 1000 * u, marks = [];
  for (const e of doc.elements) {
    // protected elements (filter, pattern, marker, ...) are never rebuilt
    if (e.removed || e.locked || !e.subpaths.length || e.fill.kind === 'none') continue;
    const topo = topology(e.subpaths, e.rule, u / (e.scale || 1));
    e.subpaths.forEach((sp, i) => {
      if (!sp.closed) return;
      const m = markInfo(e, sp, u);
      if (!m || m.size > 0.2 * size || m.size < 1.2 * u) return;
      marks.push({ el: e.idx, sub: i, hole: topo.hole[i], parent: topo.parent[i], ...m });
    });
  }
  // similar marks of the same element and role
  const par = marks.map((_, i) => i), find = (i) => (par[i] === i ? i : (par[i] = find(par[i])));
  const similar = (p, q) => p.el === q.el && p.hole === q.hole && p.area / q.area < 1.8 && q.area / p.area < 1.8 && p.elong / q.elong < 1.6 && q.elong / p.elong < 1.6;
  for (let i = 0; i < marks.length; i++) for (let j = i + 1; j < marks.length; j++) if (similar(marks[i], marks[j])) par[find(i)] = find(j);
  const buckets = new Map();
  marks.forEach((m, i) => { const r = find(i); (buckets.get(r) || buckets.set(r, []).get(r)).push(m); });
  const groups = [];
  for (const list of buckets.values()) {
    if (list.length < 3) continue;
    for (const g of arrange(list, u)) groups.push(g);
  }
  // rings made of several kinds of marks around the same centre (long ticks at the
  // quarters + short ones) are one pattern
  const rings = groups.filter((g) => g.kind === 'radial');
  const used = new Set(), out = groups.filter((g) => g.kind !== 'radial');
  for (const g of rings) {
    if (used.has(g)) continue;
    const same = rings.filter((h) => !used.has(h) && h.el === g.el && dist(h.center, g.center) < 0.08 * g.radius && Math.abs(h.radius - g.radius) < 0.15 * g.radius);
    same.forEach((h) => used.add(h));
    out.push(same.length === 1 ? g : mergeRings(same));
  }
  out.sort((a, b) => b.members.length - a.members.length);
  return out.map((g, i) => ({ ...g, id: i + 1 }));
}

function arrange(list, u) {
  const out = [];
  const C = fitCircle(list.map((m) => [m.cx, m.cy]));
  const meanSize = list.reduce((s, m) => s + m.size, 0) / list.length;
  if (C && list.length >= 3 && C.r > 1.5 * meanSize && C.err < Math.max(0.12 * C.r, 1.5 * u)) {
    out.push(radial(list, C));
    return out;
  }
  // a row: points close to a line
  const xs = list.map((m) => m.cx), ys = list.map((m) => m.cy);
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const m of list) { sxx += (m.cx - mx) ** 2; syy += (m.cy - my) ** 2; sxy += (m.cx - mx) * (m.cy - my); }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), dx = Math.cos(th), dy = Math.sin(th);
  const off = list.map((m) => Math.abs(-(m.cx - mx) * dy + (m.cy - my) * dx));
  if (Math.max(...off) < Math.max(0.5 * meanSize, 1.5 * u)) {
    const t = list.map((m) => (m.cx - mx) * dx + (m.cy - my) * dy).sort((a, b) => a - b);
    const gaps = t.slice(1).map((v, i) => v - t[i]);
    out.push({ kind: 'row', el: list[0].el, hole: list[0].hole, members: list, gapCV: cv(gaps), direction: [dx, dy] });
  }
  return out;
}
function radial(list, C) {
  const center = [C.cx, C.cy];
  const members = list.map((m) => ({ ...m, angle: norm360((Math.atan2(m.cx - C.cx, -(m.cy - C.cy)) * 180) / Math.PI) })).sort((a, b) => a.angle - b.angle);
  const gaps = members.map((m, i) => norm360((members[(i + 1) % members.length].angle - m.angle)) || 360);
  return { kind: 'radial', el: list[0].el, hole: list[0].hole, members, center, radius: C.r, gapCV: cv(gaps), gaps };
}
function mergeRings(rs) {
  const members = rs.flatMap((r) => r.members.map((m, k) => ({ ...m, type: rs.indexOf(r) }))).sort((a, b) => a.angle - b.angle);
  const center = [rs.reduce((s, r) => s + r.center[0], 0) / rs.length, rs.reduce((s, r) => s + r.center[1], 0) / rs.length];
  const radius = rs.reduce((s, r) => s + r.radius, 0) / rs.length;
  const gaps = members.map((m, i) => norm360(members[(i + 1) % members.length].angle - m.angle) || 360);
  return { kind: 'radial', el: rs[0].el, hole: rs[0].hole, members, center, radius, gapCV: cv(gaps), gaps, types: rs.length };
}
const norm360 = (a) => ((a % 360) + 360) % 360;
const cv = (v) => { if (!v.length) return 0; const m = v.reduce((a, b) => a + b, 0) / v.length; return m ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) / m : 0; };
export { norm360 };
