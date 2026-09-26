// Geometric features of subpaths (native segments: L, Q, C, A).
import { toCubics, expand } from './pathdata.js';
import { tanIn as tIn, tanOut as tOut, segLen as sLen, turnDeg, dist, sub, add, mul, norm, dot, cross, len, flatten, polyArea, polyLen, bbox, fitCircle, fitEllipse, lineDeviation, pointInPoly, interiorPoint, selfIntersections, hausdorff, segAt } from './geom.js';

export const tanIn = (s) => tIn(toCubics(s)[0]);
export const tanOut = (s) => { const c = toCubics(s); return tOut(c[c.length - 1]); };
export const segLength = (s) => toCubics(s).reduce((n, c) => n + sLen(c), 0);
export const segEnd = (s) => s.p[s.p.length - 1];
export const segStart = (s) => s.p[0];
// points along a native segment (t in 0..1 over its cubic pieces)
export function segSample(s, n) {
  const cs = toCubics(s), out = [];
  for (let i = 0; i < n; i++) { const t = (i / n) * cs.length, k = Math.min(cs.length - 1, Math.floor(t)); out.push(segAt(cs[k], t - k)); }
  return out;
}
// Dense samples of a subpath with the index of the native segment of each sample.
export function sampleNative(sp, step) {
  const pts = [], seg = [];
  sp.segs.forEach((s, k) => { const n = Math.max(1, Math.ceil(segLength(s) / step)); for (const q of segSample(s, n)) { pts.push(q); seg.push(k); } });
  if (!sp.closed && sp.segs.length) { pts.push(segEnd(sp.segs[sp.segs.length - 1])); seg.push(sp.segs.length - 1); }
  return { pts, seg };
}
export const polyOf = (sp, tol) => sp.segs.length ? flatten(expand(sp.segs), tol) : [];

// Node types at each join: node i joins seg i-1 -> seg i.
// sharp (> 60°), soft (25-60°), smooth, transition (curve <-> line, smooth), kink (2-25°), end (open)
export function nodeTypes(sp, u) {
  const n = sp.segs.length, out = [];
  for (let i = 0; i < n; i++) {
    if (!sp.closed && i === 0) { out.push({ i, type: 'end', angle: 0 }); continue; }
    const a = sp.segs[(i - 1 + n) % n], b = sp.segs[i];
    const ang = turnDeg(tanOut(a), tanIn(b));
    let type = ang > 60 ? 'sharp' : ang > 25 ? 'soft' : ang > 2 ? 'kink' : (a.t === 'L') !== (b.t === 'L') ? 'transition' : 'smooth';
    out.push({ i, type, angle: ang });
  }
  // rounded corners: a short curved segment turning > 45° between two joins that are smooth
  for (let i = 0; i < n; i++) {
    const s = sp.segs[i];
    if (s.t === 'L') continue;
    const turn = turnDeg(tanIn(s), tanOut(s));
    const L = segLength(s);
    if (turn > 45 && L < 12 * u && out[i].angle < 25 && out[(i + 1) % n] && out[(i + 1) % n].angle < 25) out[i].rounded = true;
  }
  return out;
}

// Complexity of one element.
export function complexity(e, u) {
  let commands = 0, nodes = 0, controls = 0, curves = 0, lines = 0, arcs = 0, quads = 0, closed = 0, open = 0, length = 0;
  const lens = [], turns = [];
  for (const sp of e.subpaths) {
    sp.closed ? closed++ : open++;
    commands += 1 + sp.segs.length + (sp.closed ? 1 : 0);
    nodes += sp.segs.length + (sp.closed ? 0 : 1);
    for (const s of sp.segs) {
      if (s.t === 'L') lines++; else if (s.t === 'C') { curves++; controls += 2; } else if (s.t === 'Q') { quads++; curves++; controls += 1; } else arcs++;
      const L = segLength(s); lens.push(L); length += L;
      if (s.t !== 'L') turns.push(turnDeg(tanIn(s), tanOut(s)) / Math.max(L, 1e-9));
    }
  }
  lens.sort((a, b) => a - b);
  const q = (f) => lens.length ? lens[Math.min(lens.length - 1, Math.floor(f * lens.length))] : 0;
  const mean = turns.reduce((a, b) => a + b, 0) / Math.max(1, turns.length);
  const curvVar = turns.length ? Math.sqrt(turns.reduce((a, b) => a + (b - mean) ** 2, 0) / turns.length) / Math.max(mean, 1e-9) : 0;
  // score: nodes per unit of outline length (relative to the artwork), not raw counts
  const density = nodes / Math.max(1e-9, (length * (e.scale || 1)) / (100 * u));   // nodes per 10% of artwork size
  const score = Math.log2(1 + nodes) * 0.6 + Math.log2(1 + density) * 1.4;
  const label = score < 4 ? 'Low' : score < 7 ? 'Medium' : score < 10 ? 'High' : 'Very high';
  return { commands, nodes, controls, points: nodes + controls, subpaths: e.subpaths.length, curves, quads, lines, arcs, closed, open, length, curvatureVariation: +curvVar.toFixed(2), segLen: { min: q(0), p10: q(0.1), median: q(0.5), p90: q(0.9), max: q(1) }, density: +density.toFixed(2), score: +score.toFixed(2), label };
}

// Topology of an element's subpaths: containment hierarchy, holes, components.
export function topology(subpaths, rule, tol) {
  const polys = subpaths.map((sp) => polyOf(sp, tol));
  const areas = polys.map((P) => P.length > 2 ? polyArea(P) : 0);
  const n = polys.length, parent = new Array(n).fill(-1), depth = new Array(n).fill(0);
  const ip = polys.map((P) => P.length > 2 ? interiorPoint(P) : null);
  for (let i = 0; i < n; i++) {
    if (!ip[i]) continue;
    let best = -1;
    for (let j = 0; j < n; j++) if (j !== i && polys[j].length > 2 && Math.abs(areas[j]) > Math.abs(areas[i]) && pointInPoly(ip[i], polys[j]) && (best < 0 || Math.abs(areas[j]) < Math.abs(areas[best]))) best = j;
    parent[i] = best;
  }
  for (let i = 0; i < n; i++) { let d = 0, p = parent[i]; while (p >= 0 && d < n) { d++; p = parent[p]; } depth[i] = d; }
  // a hole: evenodd -> odd depth; nonzero -> opposite winding to its parent
  const hole = polys.map((P, i) => parent[i] >= 0 && (rule === 'evenodd' ? depth[i] % 2 === 1 : Math.sign(areas[i]) !== Math.sign(areas[parent[i]])));
  return {
    contours: n, closed: subpaths.filter((s) => s.closed).length,
    holes: hole.filter(Boolean).length, components: hole.filter((h, i) => !h && polys[i].length > 2).length,
    signature: subpaths.map((s, i) => `${s.closed ? 'c' : 'o'}${depth[i]}${hole[i] ? 'h' : ''}${Math.sign(areas[i])}`).join(','),
    parent, depth, hole, areas,
  };
}

// Recognise a whole closed subpath as a geometric primitive.
// Returns [{ kind, confidence, params, deviation }] sorted by confidence.
export function recognize(sp, u) {
  if (!sp.closed || sp.segs.length < 2) return [];
  const bb0 = bbox(sp.segs.flatMap((g) => g.p)), size0 = Math.max(bb0[2] - bb0[0], bb0[3] - bb0[1]);
  const P = sampleNative(sp, Math.max(0.5 * u, size0 / 200)).pts;
  if (P.length < 8) return [];
  const bb = bbox(P), size = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
  const out = [];
  const conf = (dev, rel) => Math.max(0, Math.min(1, 1 - dev / Math.max(1e-9, rel)));
  const c = fitCircle(P);
  if (c && c.r > 0) {
    const cen = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
    out.push({ kind: 'circle', params: c, deviation: c.err, centerError: dist(cen, [c.cx, c.cy]), radiusVariance: c.radiusStd / c.r, confidence: conf(c.err, 0.04 * c.r) * conf(c.radiusStd, 0.02 * c.r) });
  }
  const e = fitEllipse(P);
  if (e && !(c && Math.abs(e.rx - e.ry) < 1e-9)) out.push({ kind: 'ellipse', params: e, deviation: e.err, confidence: conf(e.err, 0.04 * Math.min(e.rx, e.ry)) });
  // polygons: corners of the outline
  const types = nodeTypes(sp, u), corners = types.filter((t) => t.type === 'sharp' || t.type === 'soft' || t.rounded);
  const curvedLen = sp.segs.filter((s) => s.t !== 'L').reduce((a, s) => a + segLength(s), 0), total = sp.segs.reduce((a, s) => a + segLength(s), 0);
  const kinds = { 3: 'triangle', 4: 'rectangle' };
  const V = corners.map((t) => segStart(sp.segs[t.i]));
  if (V.length >= 3 && V.length <= 12) {
    // deviation of the outline from the polygon through the corners
    let dev = 0;
    for (const q of P) { let best = Infinity; for (let i = 0; i < V.length; i++) best = Math.min(best, lineDeviation([q], V[i], V[(i + 1) % V.length])); dev = Math.max(dev, best); }
    let kind = kinds[V.length] || 'polygon';
    if (V.length === 4) {
      // right angles and axis-aligned?
      const ok = V.every((v, i) => Math.abs(dot(norm(sub(V[(i + 1) % 4], v)), norm(sub(V[(i + 3) % 4], v)))) < 0.03);
      if (!ok) kind = 'quadrilateral';
    }
    out.push({ kind, params: { vertices: V }, deviation: dev, confidence: conf(dev, 0.015 * size) });
    // rounded rectangle: 4 rounded corners joined by straight sides
  }
  const rounded = types.filter((t) => t.rounded);
  if (rounded.length === 4 && curvedLen < 0.6 * total) {
    const rr = roundedRectFit(P, bb);
    if (rr) out.push({ kind: 'rounded-rectangle', params: rr, deviation: rr.err, confidence: conf(rr.err, 0.015 * size) });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}
function roundedRectFit(P, bb) {
  const w = bb[2] - bb[0], h = bb[3] - bb[1];
  let best = null;
  for (let r = 0.02; r <= 0.5; r += 0.02) {
    const R = r * Math.min(w, h);
    let err = 0;
    for (const q of P) err = Math.max(err, rrDist(q, bb, R));
    if (!best || err < best.err) best = { x: bb[0], y: bb[1], w, h, r: R, err };
  }
  return best;
}
function rrDist(q, bb, R) {
  const cx = Math.max(bb[0] + R, Math.min(bb[2] - R, q[0])), cy = Math.max(bb[1] + R, Math.min(bb[3] - R, q[1]));
  const dx = q[0] - cx, dy = q[1] - cy;
  const inCorner = (q[0] < bb[0] + R || q[0] > bb[2] - R) && (q[1] < bb[1] + R || q[1] > bb[3] - R);
  if (inCorner) return Math.abs(Math.hypot(dx, dy) - R);
  return Math.min(Math.abs(q[0] - bb[0]), Math.abs(q[0] - bb[2]), Math.abs(q[1] - bb[1]), Math.abs(q[1] - bb[3]));
}

// Organic: many curves with varying curvature and no primitive that fits.
export function organicScore(sp, u, rec) {
  const segs = sp.segs;
  if (!segs.length) return 0;
  const total = segs.reduce((a, s) => a + segLength(s), 0), curved = segs.filter((s) => s.t !== 'L').reduce((a, s) => a + segLength(s), 0);
  const k = segs.filter((s) => s.t !== 'L').map((s) => turnDeg(tanIn(s), tanOut(s)) / Math.max(segLength(s), 1e-9));
  const mean = k.reduce((a, b) => a + b, 0) / Math.max(1, k.length), sd = k.length ? Math.sqrt(k.reduce((a, b) => a + (b - mean) ** 2, 0) / k.length) : 0;
  const bestPrim = rec && rec.length ? rec[0].confidence : 0;
  return Math.max(0, Math.min(1, (curved / Math.max(total, 1e-9)) * 0.5 + Math.min(1, sd / Math.max(mean, 1e-9)) * 0.5 - bestPrim * 0.6));
}

// Mirror / radial symmetry of a closed subpath.
export function symmetry(sp, u) {
  if (!sp.closed || sp.segs.length < 4) return null;
  const bb0 = bbox(sp.segs.flatMap((g) => g.p)), size0 = Math.max(bb0[2] - bb0[0], bb0[3] - bb0[1]);
  if (size0 < 10 * u) return null;
  const P = sampleNative(sp, Math.max(0.6 * u, size0 / 150)).pts;
  const bb = bbox(P), size = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
  // axis through the area centroid
  let A = 0, cx = 0, cy = 0;
  for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length], c = p[0] * q[1] - q[0] * p[1]; A += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c; }
  if (Math.abs(A) < 1e-9) return null;
  cx /= 3 * A; cy /= 3 * A;
  const res = {};
  const conf = (d) => Math.max(0, 1 - d / (0.05 * size));
  res.vertical = { axis: cx, deviation: hausdorff(P, P.map((p) => [2 * cx - p[0], p[1]])) };
  res.horizontal = { axis: cy, deviation: hausdorff(P, P.map((p) => [p[0], 2 * cy - p[1]])) };
  let bestR = null;
  for (const n of [3, 4, 5, 6, 8]) {
    const t = (2 * Math.PI) / n, c = Math.cos(t), s = Math.sin(t);
    const d = hausdorff(P, P.map((p) => [cx + (p[0] - cx) * c - (p[1] - cy) * s, cy + (p[0] - cx) * s + (p[1] - cy) * c]));
    if (!bestR || d < bestR.deviation) bestR = { order: n, deviation: d };
  }
  res.radial = bestR;
  for (const k of ['vertical', 'horizontal', 'radial']) res[k].confidence = +conf(res[k].deviation).toFixed(3);
  res.center = [cx, cy]; res.size = size;
  return res;
}
export { selfIntersections };
